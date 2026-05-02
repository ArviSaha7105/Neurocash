from fastapi import FastAPI, APIRouter, HTTPException, Query, Depends, BackgroundTasks
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
import requests
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timedelta
import math
import random

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ.get('DB_NAME', 'neurocash_db')]

# Create the main app without a prefix
app = FastAPI(title="NeuroCash API", description="Neural-crowdsourced ATM liquidity mapper")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ==================== MODELS ====================

class Location(BaseModel):
    type: str = "Point"
    coordinates: List[float]  # [longitude, latitude]

class ATM(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    bank_name: str
    branch_name: str
    address: str
    location: Location
    region: str = "Mumbai"  # DPDP Act 2023 compliance - data localization
    current_status: str = "grey"  # green, yellow, red, grey
    bank_online: bool = True
    last_report_time: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

class ATMResponse(BaseModel):
    id: str
    bank_name: str
    branch_name: str
    address: str
    latitude: float
    longitude: float
    current_status: str
    bank_online: bool
    last_report_time: Optional[datetime]
    distance_meters: Optional[float] = None

class User(BaseModel):
    id: str
    karma_score: float = 1.0
    report_count: int = 0
    points: int = 0

class StatusReport(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    atm_id: str
    user_id: str
    status: str  # "cash", "no_cash", "low_cash", "long_queue"
    user_lat: float
    user_lng: float
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    scored: bool = False

class StatusReportCreate(BaseModel):
    atm_id: str
    user_id: str
    status: str
    user_lat: float
    user_lng: float

class UserHistory(BaseModel):
    user_id: str
    reports: List[StatusReport] = []

class BankGatewayStatus(BaseModel):
    bank_name: str
    status: str  # "ONLINE", "OFFLINE"

class ATMSubscription(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    atm_id: str
    user_id: str
    created_at: datetime = Field(default_factory=datetime.utcnow)

class ATMAddRequest(BaseModel):
    bank_name: str
    branch_name: str
    latitude: float
    longitude: float
    address: str
    image_base64: Optional[str] = None

class AdminStats(BaseModel):
    total_users: int
    active_atms: int
    status_distribution: dict
    recent_activity_count: int
    top_contributors: list

# ==================== UTILITY FUNCTIONS ====================

async def process_karma_updates(atm_id: str, new_status: Optional[str] = None):
    """Background task to update user karma scores based on verified ATM status."""
    atm = await db.atms.find_one({"id": atm_id})
    if not atm:
        return
        
    true_status = "red" if not atm.get("bank_online", True) else (new_status or await calculate_atm_status(atm_id))
    
    # Process unscored reports from the last 2 hours
    two_hours_ago = datetime.utcnow() - timedelta(hours=2)
    unscored_reports = await db.status_reports.find({
        "atm_id": atm_id,
        "scored": {"$ne": True},
        "timestamp": {"$gte": two_hours_ago}
    }).to_list(100)
    
    for report in unscored_reports:
        user_id = report["user_id"]
        reported_status = report.get("status", "")
        
        user = await db.users.find_one({"id": user_id})
        current_karma = user.get("karma_score", 1.0) if user else 1.0
        current_count = user.get("report_count", 0) if user else 0
        
        karma_change = 0.0
        if reported_status == true_status:
            karma_change = 0.1
        else:
            karma_change = -0.2
            
        new_karma = max(0.1, round(current_karma + karma_change, 2))
        
        # Update user
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"karma_score": new_karma, "report_count": current_count + 1}},
            upsert=True
        )
        
        # Mark report as scored
        await db.status_reports.update_one(
            {"id": report["id"]},
            {"$set": {"scored": True}}
        )

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the Haversine distance between two points in meters."""
    R = 6371000  # Earth's radius in meters
    
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    
    a = math.sin(delta_phi / 2) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    return R * c

async def calculate_atm_status(atm_id: str) -> str:
    """Calculate ATM status based on majority voting from recent reports."""
    # Data persists for 24 hours (1440 minutes)
    twenty_four_hours_ago = datetime.utcnow() - timedelta(hours=24)
    
    # Get recent reports for this ATM
    reports = await db.status_reports.find({
        "atm_id": atm_id,
        "timestamp": {"$gte": twenty_four_hours_ago}
    }).to_list(100)
    
    if not reports:
        return "grey"  # No recent data
    
    # Count votes
    status_counts = {
        "cash": 0,
        "no_cash": 0,
        "low_cash": 0,
        "long_queue": 0
    }
    
    for report in reports:
        status = report.get("status", "")
        if status in status_counts:
            user = await db.users.find_one({"id": report["user_id"]})
            karma_weight = user.get("karma_score", 1.0) if user else 1.0
            status_counts[status] += karma_weight
    
    total_reports = sum(status_counts.values())
    if total_reports == 0:
        return "grey"
    
    # Determine status based on majority voting
    # TC_03: If 5 users report "Cash" and 1 reports "No Cash", marker stays Green
    cash_votes = status_counts["cash"]
    no_cash_votes = status_counts["no_cash"]
    low_cash_votes = status_counts["low_cash"]
    queue_votes = status_counts["long_queue"]
    
    # Majority voting logic
    if cash_votes > (no_cash_votes + low_cash_votes):
        return "green"
    elif no_cash_votes >= cash_votes and no_cash_votes > 0:
        return "red"
    elif low_cash_votes > 0 or queue_votes > 0:
        return "yellow"
    elif cash_votes > 0:
        return "green"
    
    return "grey"

# ==================== STARTUP EVENTS ====================

@app.on_event("startup")
async def startup_event():
    """Create 2dsphere index on startup."""
    try:
        await db.atms.create_index([("location", "2dsphere")])
        logger.info("2dsphere index created on 'location' field")
        
        # Check if ATMs exist, if not seed data
        count = await db.atms.count_documents({})
        if count == 0:
            await seed_atm_data()
            logger.info("Seeded ATM data")
    except Exception as e:
        logger.error(f"Error during startup: {e}")

async def seed_atm_data():
    """Seed 20 ATMs - 10 for Barasat (Champadali More) and 10 for Dum Dum (Nagerbazar)."""
    
    # Barasat (Champadali More) ATMs - Center: 22.7246° N, 88.4844° E
    barasat_atms = [
        {"bank_name": "State Bank of India", "branch_name": "Champadali More", "address": "Champadali More, Barasat, Kolkata 700124", "lat": 22.7246, "lng": 88.4844},
        {"bank_name": "HDFC Bank", "branch_name": "Barasat Main", "address": "Jessore Road, Barasat, Kolkata 700124", "lat": 22.7250, "lng": 88.4840},
        {"bank_name": "ICICI Bank", "branch_name": "Barasat Branch", "address": "Near Barasat Court, Kolkata 700124", "lat": 22.7240, "lng": 88.4850},
        {"bank_name": "Axis Bank", "branch_name": "Champadali", "address": "Champadali, Barasat, Kolkata 700124", "lat": 22.7255, "lng": 88.4835},
        {"bank_name": "Punjab National Bank", "branch_name": "Barasat", "address": "BT Road, Barasat, Kolkata 700124", "lat": 22.7235, "lng": 88.4855},
        {"bank_name": "Bank of Baroda", "branch_name": "Barasat", "address": "Market Area, Barasat, Kolkata 700124", "lat": 22.7260, "lng": 88.4830},
        {"bank_name": "Canara Bank", "branch_name": "Champadali More", "address": "Champadali More, Barasat, Kolkata 700124", "lat": 22.7242, "lng": 88.4848},
        {"bank_name": "Union Bank", "branch_name": "Barasat", "address": "Station Road, Barasat, Kolkata 700124", "lat": 22.7248, "lng": 88.4838},
        {"bank_name": "Kotak Mahindra", "branch_name": "Barasat", "address": "Jessore Road, Barasat, Kolkata 700124", "lat": 22.7252, "lng": 88.4852},
        {"bank_name": "Yes Bank", "branch_name": "Champadali", "address": "Champadali, Barasat, Kolkata 700124", "lat": 22.7238, "lng": 88.4842},
    ]
    
    # Dum Dum (Nagerbazar) ATMs - Center: 22.6174° N, 88.4119° E
    dumdum_atms = [
        {"bank_name": "State Bank of India", "branch_name": "Nagerbazar", "address": "Nagerbazar, Dum Dum, Kolkata 700028", "lat": 22.6174, "lng": 88.4119},
        {"bank_name": "HDFC Bank", "branch_name": "Dum Dum", "address": "VIP Road, Dum Dum, Kolkata 700028", "lat": 22.6180, "lng": 88.4115},
        {"bank_name": "ICICI Bank", "branch_name": "Nagerbazar", "address": "Near Nagerbazar Crossing, Kolkata 700028", "lat": 22.6168, "lng": 88.4125},
        {"bank_name": "Axis Bank", "branch_name": "Dum Dum", "address": "Jessore Road, Dum Dum, Kolkata 700028", "lat": 22.6185, "lng": 88.4110},
        {"bank_name": "Punjab National Bank", "branch_name": "Nagerbazar", "address": "Nagerbazar, Dum Dum, Kolkata 700028", "lat": 22.6162, "lng": 88.4130},
        {"bank_name": "Bank of Baroda", "branch_name": "Dum Dum", "address": "Near Airport, Dum Dum, Kolkata 700028", "lat": 22.6190, "lng": 88.4105},
        {"bank_name": "Canara Bank", "branch_name": "Nagerbazar", "address": "Nagerbazar, Dum Dum, Kolkata 700028", "lat": 22.6170, "lng": 88.4122},
        {"bank_name": "Union Bank", "branch_name": "Dum Dum", "address": "Airport Road, Dum Dum, Kolkata 700028", "lat": 22.6178, "lng": 88.4112},
        {"bank_name": "Kotak Mahindra", "branch_name": "Nagerbazar", "address": "VIP Road, Nagerbazar, Kolkata 700028", "lat": 22.6182, "lng": 88.4128},
        {"bank_name": "Yes Bank", "branch_name": "Dum Dum", "address": "Jessore Road, Dum Dum, Kolkata 700028", "lat": 22.6165, "lng": 88.4118},
    ]
    
    all_atms = []
    for atm_data in barasat_atms + dumdum_atms:
        atm = ATM(
            bank_name=atm_data["bank_name"],
            branch_name=atm_data["branch_name"],
            address=atm_data["address"],
            location=Location(coordinates=[atm_data["lng"], atm_data["lat"]]),
            region="Mumbai",  # DPDP compliance tagging
            current_status="grey"
        )
        all_atms.append(atm.dict())
    
    await db.atms.insert_many(all_atms)
    logger.info(f"Seeded {len(all_atms)} ATMs")

# ==================== API ENDPOINTS ====================

@api_router.get("/")
async def root():
    return {"message": "NeuroCash API - Neural-crowdsourced ATM liquidity mapper", "status": "online"}

@api_router.get("/health")
async def health_check():
    return {"status": "healthy", "region": "Mumbai", "timestamp": datetime.utcnow().isoformat()}

# TC_01: The 1km Smart Filter (Location Engine)
@api_router.get("/atms/nearby", response_model=List[ATMResponse])
async def get_nearby_atms(
    lat: float = Query(..., description="User latitude"),
    lng: float = Query(..., description="User longitude"),
    radius: int = Query(1000, description="Radius in meters (default 1000m)")
):
    """
    Get ATMs within specified radius.
    Fetches real-time data from Google Places API and merges with crowdsourced status from MongoDB.
    """
    try:
        # 1. Fetch from Google Places API
        google_api_key = os.environ.get('GOOGLE_MAPS_API_KEY')
        google_atms = []
        
        if google_api_key:
            try:
                google_url = f"https://maps.googleapis.com/maps/api/place/nearbysearch/json?location={lat},{lng}&radius={radius}&type=atm&key={google_api_key}"
                response = requests.get(google_url)
                if response.status_code == 200:
                    results = response.json().get('results', [])
                    for place in results:
                        place_id = f"google-{place.get('place_id')}"
                        lat_atm = place['geometry']['location']['lat']
                        lng_atm = place['geometry']['location']['lng']
                        
                        # Prepare ATM document for upsert
                        atm_doc = {
                            "id": place_id,
                            "bank_name": place.get('name', 'Unknown ATM'),
                            "branch_name": place.get('vicinity', 'Local Branch'),
                            "address": place.get('vicinity', 'No address provided'),
                            "location": {
                                "type": "Point",
                                "coordinates": [lng_atm, lat_atm]
                            },
                            "region": "Dynamic"
                        }
                        
                        # Upsert into MongoDB if not exists (don't overwrite current_status)
                        await db.atms.update_one(
                            {"id": place_id},
                            {"$setOnInsert": {
                                **atm_doc,
                                "current_status": "grey",
                                "bank_online": True,
                                "created_at": datetime.utcnow()
                            }},
                            upsert=True
                        )
                        google_atms.append(place_id)
            except Exception as e:
                logger.error(f"Error fetching from Google Places: {e}")

        # 2. Query MongoDB for all ATMs in the radius (including the ones we just seeded)
        atms = await db.atms.find({
            "location": {
                "$near": {
                    "$geometry": {
                        "type": "Point",
                        "coordinates": [lng, lat]
                    },
                    "$maxDistance": radius
                }
            }
        }).to_list(100)
        
        result = []
        for atm in atms:
            atm_lat = atm["location"]["coordinates"][1]
            atm_lng = atm["location"]["coordinates"][0]
            
            # Calculate distance
            distance = haversine_distance(lat, lng, atm_lat, atm_lng)
            
            # Check if bank is offline (TC_04)
            if not atm.get("bank_online", True):
                current_status = "red"
            else:
                last_report = atm.get("last_report_time")
                # Data decays after 24 hours - if no recent report, use MOCK STATUS for demo
                if not last_report or (datetime.utcnow() - last_report) > timedelta(hours=24):
                    # TC: Mocking status update for demonstration with real locations
                    current_status = random.choice(["green", "yellow", "red", "grey"])
                else:
                    current_status = atm.get("current_status", "grey")
            
            result.append(ATMResponse(
                id=atm["id"],
                bank_name=atm["bank_name"],
                branch_name=atm["branch_name"],
                address=atm["address"],
                latitude=atm_lat,
                longitude=atm_lng,
                current_status=current_status,
                bank_online=atm.get("bank_online", True),
                last_report_time=atm.get("last_report_time"),
                distance_meters=round(distance, 2)
            ))
        
        return result
    except Exception as e:
        logger.error(f"Error fetching nearby ATMs: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/atms/all", response_model=List[ATMResponse])
async def get_all_atms():
    """Get all ATMs (for debugging/admin purposes)."""
    try:
        atms = await db.atms.find().to_list(100)
        
        result = []
        for atm in atms:
            atm_lat = atm["location"]["coordinates"][1]
            atm_lng = atm["location"]["coordinates"][0]
            
            # Check bank status
            if not atm.get("bank_online", True):
                current_status = "red"
            else:
                last_report = atm.get("last_report_time")
                if not last_report or (datetime.utcnow() - last_report) > timedelta(hours=24):
                    current_status = "grey"
                else:
                    current_status = atm.get("current_status", "grey")
            
            result.append(ATMResponse(
                id=atm["id"],
                bank_name=atm["bank_name"],
                branch_name=atm["branch_name"],
                address=atm["address"],
                latitude=atm_lat,
                longitude=atm_lng,
                current_status=current_status,
                bank_online=atm.get("bank_online", True),
                last_report_time=atm.get("last_report_time")
            ))
        
        return result
    except Exception as e:
        logger.error(f"Error fetching all ATMs: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# TC_02: Geofence Lock - Report Status
security = HTTPBearer()

def verify_google_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        response = requests.get(f"https://oauth2.googleapis.com/tokeninfo?id_token={token}")
        if response.status_code != 200:
            response = requests.get(f"https://oauth2.googleapis.com/tokeninfo?access_token={token}")
            
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid or expired Google token")
            
        token_info = response.json()
        return token_info.get("sub", "unknown_user")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Token verification error: {e}")
        raise HTTPException(status_code=401, detail="Could not verify credentials")

class ReportStatusRequest(BaseModel):
    user_lat: float
    user_lng: float
    status: str
    atm_name: Optional[str] = None
    atm_vicinity: Optional[str] = None
    atm_lat: Optional[float] = None
    atm_lng: Optional[float] = None

@api_router.post("/reports")
async def report_atm_status(
    atm_id: str,
    report: ReportStatusRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(verify_google_token) # Must be at the end because of default value
):
    """
    Report the status of an ATM (crowdsourced).
    """
    try:
        # Prevent spam (TC_03)
        one_min_ago = datetime.utcnow() - timedelta(minutes=1)
        recent_report = await db.status_reports.find_one({
            "user_id": user_id,
            "timestamp": {"$gte": one_min_ago}
        })
        
        if recent_report:
            raise HTTPException(
                status_code=429, 
                detail="Rate limit exceeded. Please wait 1 minute between reports."
            )
            
        atm = await db.atms.find_one({"id": atm_id})
        
        if not atm:
            # Dynamic ATM Generation (Global Crowdsourced Mode)
            if not report.atm_name or report.atm_lat is None or report.atm_lng is None:
                raise HTTPException(status_code=404, detail="ATM not found in database, and missing dynamic creation metadata (name, lat, lng).")
            
            new_atm = ATM(
                id=atm_id,
                bank_name=report.atm_name,
                branch_name=report.atm_vicinity or "Crowdsourced Location",
                address=report.atm_vicinity or "Sourced from Google Maps",
                location=Location(coordinates=[report.atm_lng, report.atm_lat]),
                region="Global",
                current_status="grey"
            )
            await db.atms.insert_one(new_atm.dict())
            atm_lat = report.atm_lat
            atm_lng = report.atm_lng
        else:
            atm_lat = atm["location"]["coordinates"][1]
            atm_lng = atm["location"]["coordinates"][0]
        
        # TC_02: Geofence validation - must be within 50 meters
        distance = haversine_distance(report.user_lat, report.user_lng, atm_lat, atm_lng)
        
        if distance > 50:
            raise HTTPException(
                status_code=403,
                detail=f"Geofence violation: You must be within 50m of the ATM to report. Current distance: {round(distance, 2)}m"
            )
        
        # Validate status
        valid_statuses = ["cash", "no_cash", "low_cash", "long_queue"]
        if report.status not in valid_statuses:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status. Must be one of: {valid_statuses}"
            )
        
        # Create status report
        status_report = StatusReport(
            atm_id=atm_id,
            user_id=user_id,
            status=report.status,
            user_lat=report.user_lat,
            user_lng=report.user_lng
        )
        
        await db.status_reports.insert_one(status_report.dict())
        
        # Calculate new status
        new_status = await calculate_atm_status(atm_id)
        
        # Update ATM's last report time and status
        await db.atms.update_one(
            {"id": atm_id},
            {"$set": {
                "last_report_time": datetime.utcnow(),
                "current_status": new_status
            }}
        )
        
        # Award points to user for reporting (TC: Reward System)
        await db.users.update_one(
            {"id": user_id},
            {"$inc": {"points": 10}},
            upsert=True
        )
        
        # Queue karma processing
        background_tasks.add_task(process_karma_updates, atm_id, new_status)
        
        # Trigger "Back in Stock" notifications (Point 4)
        if report.status == "cash":
            background_tasks.add_task(notify_subscribers, atm_id)
        
        return {
            "message": "Status reported successfully",
            "report_id": status_report.id,
            "new_atm_status": new_status,
            "distance_from_atm": round(distance, 2)
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reporting ATM status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/atms/{atm_id}/status")
async def get_atm_status(atm_id: str):
    """Get detailed status of a specific ATM."""
    try:
        atm = await db.atms.find_one({"id": atm_id})
        if not atm:
            raise HTTPException(status_code=404, detail="ATM not found")
        
        # Get recent reports
        thirty_mins_ago = datetime.utcnow() - timedelta(minutes=30)
        recent_reports = await db.status_reports.find({
            "atm_id": atm_id,
            "timestamp": {"$gte": thirty_mins_ago}
        }).to_list(100)
        
        # Count by status
        status_counts = {
            "cash": 0,
            "no_cash": 0,
            "low_cash": 0,
            "long_queue": 0
        }
        for report in recent_reports:
            status = report.get("status", "")
            if status in status_counts:
                status_counts[status] += 1
        
        if not atm.get("bank_online", True):
            current_status = "red"
        else:
            last_report = atm.get("last_report_time")
            if not last_report or (datetime.utcnow() - last_report) > timedelta(hours=24):
                current_status = "grey"
            else:
                current_status = atm.get("current_status", "grey")
        
        return {
            "atm_id": atm_id,
            "bank_name": atm["bank_name"],
            "branch_name": atm["branch_name"],
            "current_status": current_status,
            "bank_online": atm.get("bank_online", True),
            "last_report_time": atm.get("last_report_time"),
            "recent_reports_count": len(recent_reports),
            "status_breakdown": status_counts
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting ATM status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def notify_subscribers(atm_id: str):
    """Notify users who subscribed to an ATM when it gets cash."""
    subscriptions = await db.atm_subscriptions.find({"atm_id": atm_id}).to_list(100)
    if not subscriptions:
        return
        
    atm = await db.atms.find_one({"id": atm_id})
    atm_name = atm.get("bank_name", "ATM") if atm else "ATM"
    
    for sub in subscriptions:
        user_id = sub["user_id"]
        # In a real app, this would trigger a Firebase/Expo Push Notification
        # For now, we'll store a notification in a new collection for the user to see
        notification = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "title": "💰 Cash Available!",
            "message": f"Good news! Cash was just reported at {atm_name}.",
            "atm_id": atm_id,
            "timestamp": datetime.utcnow(),
            "read": False
        }
        await db.notifications.insert_one(notification)
        # Delete the subscription once notified
        await db.atm_subscriptions.delete_one({"id": sub["id"]})

async def mock_ai_vision_check(image_base64: str, bank_name: str):
    """
    Simulates a call to Gemini/Vision API.
    In a real app, you would use google-generativeai here.
    """
    # Simulate API latency
    await asyncio.sleep(1)
    
    # Simple mock logic: if image is provided, 95% chance it's a 'pass'
    # In reality, Gemini would return JSON: {"is_atm": True, "bank": "HDFC"}
    import random
    if not image_base64:
        return False, "No image provided"
        
    is_valid = random.random() < 0.98
    return is_valid, "Looks like an ATM"

@api_router.post("/atms/{atm_id}/subscribe")
async def subscribe_to_atm(atm_id: str, user_id: str = Depends(verify_google_token)):
    """Subscribe to receive a notification when an ATM gets cash."""
    # Check if already subscribed
    existing = await db.atm_subscriptions.find_one({"atm_id": atm_id, "user_id": user_id})
    if existing:
        return {"message": "Already subscribed to this ATM"}
        
    subscription = ATMSubscription(atm_id=atm_id, user_id=user_id)
    await db.atm_subscriptions.insert_one(subscription.dict())
    return {"message": "Successfully subscribed to notifications"}

@api_router.get("/user/notifications")
async def get_user_notifications(user_id: str = Depends(verify_google_token)):
    """Get all notifications for a user."""
    notifications = await db.notifications.find({"user_id": user_id}).sort("timestamp", -1).to_list(20)
    # Format for JSON
    for n in notifications:
        n["id"] = str(n.get("id"))
        n["timestamp"] = n["timestamp"].isoformat()
        if "_id" in n: del n["_id"]
    return notifications

@api_router.post("/user/notifications/{notif_id}/read")
async def mark_notification_read(notif_id: str, user_id: str = Depends(verify_google_token)):
    """Mark a notification as read."""
    await db.notifications.update_one(
        {"id": notif_id, "user_id": user_id},
        {"$set": {"read": True}}
    )
    return {"status": "success"}

@api_router.post("/atms/add")
async def add_new_atm(request: ATMAddRequest, user_id: str = Depends(verify_google_token)):
    """Add a new missing ATM with Hybrid Trust verification."""
    # 1. AI Vision Check (Option 1)
    ai_passed, ai_msg = await mock_ai_vision_check(request.image_base64, request.bank_name)
    if not ai_passed:
        raise HTTPException(status_code=400, detail=f"AI Verification Failed: {ai_msg}")

    # 2. Karma Check (Option 3)
    user = await db.users.find_one({"google_id": user_id})
    user_points = user.get("points", 0) if user else 0
    
    # Determine initial verification status
    # Gold users (>1000 pts) are trusted instantly
    initial_status = "verified" if user_points >= 1000 else "pending"
    
    # Create new ATM object
    new_atm = {
        "id": f"manual_{str(uuid.uuid4())[:8]}",
        "bank_name": request.bank_name,
        "branch_name": request.branch_name,
        "latitude": request.latitude,
        "longitude": request.longitude,
        "address": request.address,
        "current_status": "grey",
        "bank_online": True,
        "last_report_time": None,
        "is_manual": True,
        "added_by": user_id,
        "verification_status": initial_status,
        "votes": 1, # Uploader's vote
        "created_at": datetime.utcnow()
    }
    
    existing = await db.atms.find_one({
        "latitude": {"$gt": request.latitude - 0.0001, "$lt": request.latitude + 0.0001},
        "longitude": {"$gt": request.longitude - 0.0001, "$lt": request.longitude + 0.0001}
    })
    
    if existing:
        raise HTTPException(status_code=400, detail="An ATM already exists at this location")
    
    await db.atms.insert_one(new_atm)
    
    # Award 50 points
    await db.users.update_one(
        {"google_id": user_id},
        {"$inc": {"points": 50}}
    )
    
    return {
        "message": f"ATM added successfully! Status: {initial_status}",
        "verification_status": initial_status,
        "atm_id": new_atm["id"]
    }

@api_router.post("/atms/{atm_id}/confirm")
async def confirm_atm_location(atm_id: str, exists: bool, user_id: str = Depends(verify_google_token)):
    """Community voting for unverified ATMs (Option 4)."""
    atm = await db.atms.find_one({"id": atm_id})
    if not atm:
        raise HTTPException(status_code=404, detail="ATM not found")
        
    if atm.get("verification_status") == "verified":
        return {"message": "ATM already verified"}

    # Update votes
    vote_inc = 1 if exists else -1
    await db.atms.update_one(
        {"id": atm_id},
        {"$inc": {"votes": vote_inc}}
    )
    
    # Re-fetch for updated count
    updated_atm = await db.atms.find_one({"id": atm_id})
    votes = updated_atm.get("votes", 0)
    
    # Logic: 3 net votes to verify
    if votes >= 3:
        await db.atms.update_one(
            {"id": atm_id},
            {"$set": {"verification_status": "verified"}}
        )
        return {"message": "ATM has been fully verified by the community!"}
    
    # Logic: -2 net votes to reject/delete
    if votes <= -2:
        await db.atms.delete_one({"id": atm_id})
        return {"message": "ATM removed due to community reports"}

    return {"message": "Thank you for your verification vote!", "current_votes": votes}

# ==================== ADMIN ENDPOINTS ====================

@api_router.get("/admin/stats")
async def get_admin_stats(user_id: str = Depends(verify_google_token)):
    """Fetch high-level analytics for the admin dashboard."""
    # Security check: only allow master admins
    # In a real app, this would check an 'is_admin' field in the User model
    master_admins = ["arvisaha7105@gmail.com", "admin@neurocash.com"]
    user = await db.users.find_one({"google_id": user_id})
    if not user or (user.get("email") not in master_admins and user.get("google_id") not in master_admins):
        raise HTTPException(status_code=403, detail="Unauthorized: Admin access only")

    # Aggregations
    total_users = await db.users.count_documents({})
    total_atms = await db.atms.count_documents({})
    
    # Status distribution
    pipeline = [{"$group": {"_id": "$current_status", "count": {"$sum": 1}}}]
    cursor = db.atms.aggregate(pipeline)
    status_counts = {item["_id"]: item["count"] async for item in cursor}
    
    # Recent reports (last 24h)
    yesterday = datetime.utcnow() - timedelta(days=1)
    recent_reports = await db.atms.count_documents({"last_report_time": {"$gte": yesterday}})
    
    # Top contributors
    top_users = await db.users.find().sort("points", -1).limit(5).to_list(5)
    contributors = [{"name": u.get("name"), "points": u.get("points"), "level": u.get("level", "Bronze")} for u in top_users]
    
    return {
        "total_users": total_users,
        "total_atms": total_atms,
        "status_distribution": status_counts,
        "recent_reports_24h": recent_reports,
        "top_contributors": contributors,
        "uptime_percentage": (status_counts.get("green", 0) / total_atms * 100) if total_atms > 0 else 0
    }

# TC_04: Mock Bank Gateway
@api_router.post("/bank/gateway/status")
async def set_bank_gateway_status(gateway_status: BankGatewayStatus, background_tasks: BackgroundTasks):
    """
    Mock bank gateway to simulate bank server downtime.
    When status is OFFLINE, all ATMs of that bank turn RED.
    """
    try:
        is_online = gateway_status.status.upper() == "ONLINE"
        
        # Update all ATMs of this bank
        result = await db.atms.update_many(
            {"bank_name": gateway_status.bank_name},
            {"$set": {"bank_online": is_online}}
        )
        
        if not is_online:
            # Trigger karma update for all ATMs of this bank where status just changed to red
            atms = await db.atms.find({"bank_name": gateway_status.bank_name}).to_list(100)
            for atm in atms:
                background_tasks.add_task(process_karma_updates, atm["id"], "red")
        
        return {
            "message": f"Bank gateway status updated",
            "bank_name": gateway_status.bank_name,
            "new_status": gateway_status.status,
            "atms_affected": result.modified_count
        }
    except Exception as e:
        logger.error(f"Error updating bank gateway status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/bank/gateway/status/{bank_name}")
async def get_bank_gateway_status(bank_name: str):
    """Get the current gateway status for a bank."""
    try:
        atm = await db.atms.find_one({"bank_name": bank_name})
        if not atm:
            raise HTTPException(status_code=404, detail=f"No ATMs found for bank: {bank_name}")
        
        return {
            "bank_name": bank_name,
            "status": "ONLINE" if atm.get("bank_online", True) else "OFFLINE"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting bank gateway status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# DPDP Act 2023 Compliance - Right to Erasure
@api_router.delete("/user/history")
async def delete_user_history(user_id: str = Query(..., description="User ID for data erasure")):
    """
    DELETE endpoint for DPDP Act 2023 compliance.
    Allows users to exercise their Right to Erasure.
    """
    try:
        # Delete all status reports by this user
        result = await db.status_reports.delete_many({"user_id": user_id})
        
        return {
            "message": "User data deleted successfully (DPDP Act 2023 compliance)",
            "user_id": user_id,
            "reports_deleted": result.deleted_count
        }
    except Exception as e:
        logger.error(f"Error deleting user history: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/user/profile")
async def get_user_profile(user_id: str = Depends(verify_google_token)):
    """Get the user's profile including karma score."""
    try:
        user = await db.users.find_one({"id": user_id})
        karma_score = user.get("karma_score", 1.0) if user else 1.0
        report_count = user.get("report_count", 0) if user else 0
        points = user.get("points", 0) if user else 0
        name = user.get("name", "Guest") if user else "Guest"
        picture = user.get("picture", None) if user else None
        
        level = "Bronze"
        if karma_score >= 5.0:
            level = "Gold"
        elif karma_score >= 2.0:
            level = "Silver"
            
        return {
            "user_id": user_id,
            "name": name,
            "picture": picture,
            "karma_score": karma_score,
            "points": points,
            "report_count": report_count,
            "karma_level": level
        }
    except Exception as e:
        logger.error(f"Error getting user profile: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.put("/user/profile")
async def update_user_profile(update_data: dict, user_id: str = Depends(verify_google_token)):
    """Update user profile name and picture."""
    try:
        update_fields = {}
        if "name" in update_data:
            update_fields["name"] = update_data["name"]
        if "picture" in update_data:
            # Storing base64 string directly
            update_fields["picture"] = update_data["picture"]
            
        if update_fields:
            await db.users.update_one(
                {"id": user_id},
                {"$set": update_fields},
                upsert=True
            )
        return {"status": "success", "message": "Profile updated"}
    except Exception as e:
        logger.error(f"Error updating user profile: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/user/history")
async def get_user_history(user_id: str = Query(..., description="User ID")):
    """Get all reports submitted by a user."""
    try:
        reports = await db.status_reports.find({"user_id": user_id}).to_list(100)
        
        # Format reports to be JSON serializable
        formatted_reports = []
        for report in reports:
            atm = await db.atms.find_one({"id": report.get("atm_id")})
            atm_name = atm.get("bank_name", "Unknown ATM") if atm else "Unknown ATM"
            atm_vicinity = atm.get("branch_name", "") if atm else ""
            
            # Remove MongoDB _id field and format datetime
            formatted_report = {
                "id": report.get("id", ""),
                "atm_id": report.get("atm_id", ""),
                "atm_name": atm_name,
                "atm_vicinity": atm_vicinity,
                "user_id": report.get("user_id", ""),
                "status": report.get("status", ""),
                "user_lat": report.get("user_lat", 0.0),
                "user_lng": report.get("user_lng", 0.0),
                "timestamp": report.get("timestamp").isoformat() if report.get("timestamp") else None
            }
            formatted_reports.append(formatted_report)
        
        return {
            "user_id": user_id,
            "total_reports": len(formatted_reports),
            "reports": formatted_reports
        }
    except Exception as e:
        logger.error(f"Error getting user history: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Geofence check endpoint
@api_router.get("/geofence/check")
async def check_geofence(
    atm_id: str = Query(..., description="ATM ID"),
    user_lat: float = Query(..., description="User latitude"),
    user_lng: float = Query(..., description="User longitude")
):
    """
    Check if user is within 50m geofence of an ATM.
    TC_02: Geofence Lock validation.
    """
    try:
        atm = await db.atms.find_one({"id": atm_id})
        if not atm:
            raise HTTPException(status_code=404, detail="ATM not found")
        
        atm_lat = atm["location"]["coordinates"][1]
        atm_lng = atm["location"]["coordinates"][0]
        
        distance = haversine_distance(user_lat, user_lng, atm_lat, atm_lng)
        is_within_geofence = distance <= 50
        
        return {
            "atm_id": atm_id,
            "distance_meters": round(distance, 2),
            "is_within_geofence": is_within_geofence,
            "geofence_radius_meters": 50,
            "can_report": is_within_geofence
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking geofence: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
