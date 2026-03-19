#!/usr/bin/env python3
"""
NeuroCash Backend API Test Suite
Comprehensive testing for all backend endpoints as per review request.
"""

import requests
import json
import time
from typing import Dict, List, Any
from datetime import datetime

# Configuration
BASE_URL = "http://localhost:8000/api"
BARASAT_LAT = 22.7246
BARASAT_LNG = 88.4844
WITHIN_GEOFENCE_LAT = 22.7247  # Very close to an ATM
WITHIN_GEOFENCE_LNG = 88.4845
OUTSIDE_GEOFENCE_LAT = 22.7300  # Far from ATMs
OUTSIDE_GEOFENCE_LNG = 88.4900

class NeuroCashAPITester:
    def __init__(self):
        self.base_url = BASE_URL
        self.session = requests.Session()
        self.atm_id = None
        self.test_results = []
        
    def log_test(self, test_name: str, status: str, details: str = "", response_data: Dict = None):
        """Log test results"""
        result = {
            "test": test_name,
            "status": status,
            "details": details,
            "timestamp": datetime.now().isoformat(),
            "response_data": response_data
        }
        self.test_results.append(result)
        status_symbol = "✅" if status == "PASS" else "❌"
        print(f"{status_symbol} {test_name}: {status}")
        if details:
            print(f"   Details: {details}")
        if status == "FAIL" and response_data:
            print(f"   Response: {json.dumps(response_data, indent=2)}")
        print()

    def get(self, endpoint: str, params: Dict = None) -> requests.Response:
        """Make GET request"""
        url = f"{self.base_url}{endpoint}"
        return self.session.get(url, params=params)
    
    def post(self, endpoint: str, data: Dict = None) -> requests.Response:
        """Make POST request"""
        url = f"{self.base_url}{endpoint}"
        return self.session.post(url, json=data)
    
    def delete(self, endpoint: str, params: Dict = None) -> requests.Response:
        """Make DELETE request"""
        url = f"{self.base_url}{endpoint}"
        return self.session.delete(url, params=params)
    
    def test_basic_endpoints(self):
        """Test basic health and welcome endpoints"""
        print("=== TESTING BASIC ENDPOINTS ===")
        
        # Test root endpoint
        try:
            response = self.get("/")
            if response.status_code == 200:
                data = response.json()
                if "message" in data and "NeuroCash" in data["message"]:
                    self.log_test("GET /api/", "PASS", f"Welcome message received: {data['message']}", data)
                else:
                    self.log_test("GET /api/", "FAIL", f"Unexpected response format", data)
            else:
                self.log_test("GET /api/", "FAIL", f"Status code: {response.status_code}", {"status_code": response.status_code})
        except Exception as e:
            self.log_test("GET /api/", "FAIL", f"Exception: {str(e)}")
        
        # Test health endpoint
        try:
            response = self.get("/health")
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "healthy":
                    self.log_test("GET /api/health", "PASS", f"Health check passed", data)
                else:
                    self.log_test("GET /api/health", "FAIL", f"Health status not healthy", data)
            else:
                self.log_test("GET /api/health", "FAIL", f"Status code: {response.status_code}")
        except Exception as e:
            self.log_test("GET /api/health", "FAIL", f"Exception: {str(e)}")
    
    def test_atm_all_endpoint(self):
        """Test GET /api/atms/all - should return all 20 ATMs"""
        print("=== TESTING ATM ALL ENDPOINT ===")
        
        try:
            response = self.get("/atms/all")
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) >= 20:
                    # Get first ATM ID for later tests
                    if data:
                        self.atm_id = data[0]["id"]
                    self.log_test("GET /api/atms/all", "PASS", f"Retrieved {len(data)} ATMs, ATM ID for testing: {self.atm_id}")
                    
                    # Verify required fields
                    atm = data[0]
                    required_fields = ["id", "bank_name", "branch_name", "address", "latitude", "longitude", "current_status", "bank_online"]
                    missing_fields = [field for field in required_fields if field not in atm]
                    if missing_fields:
                        self.log_test("ATM data structure", "FAIL", f"Missing fields: {missing_fields}")
                    else:
                        self.log_test("ATM data structure", "PASS", "All required fields present")
                        
                else:
                    self.log_test("GET /api/atms/all", "FAIL", f"Expected 20 ATMs, got {len(data) if isinstance(data, list) else 'non-list'}", data)
            else:
                self.log_test("GET /api/atms/all", "FAIL", f"Status code: {response.status_code}")
        except Exception as e:
            self.log_test("GET /api/atms/all", "FAIL", f"Exception: {str(e)}")
    
    def test_tc_01_smart_filter(self):
        """TC_01: Test 1km Smart Filter - GET /api/atms/nearby"""
        print("=== TESTING TC_01: 1km SMART FILTER ===")
        
        try:
            # Test with Barasat coordinates and 1000m radius
            params = {
                "lat": BARASAT_LAT,
                "lng": BARASAT_LNG,
                "radius": 1000
            }
            response = self.get("/atms/nearby", params)
            
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    self.log_test("TC_01: Nearby ATMs", "PASS", f"Found {len(data)} ATMs within 1km of Barasat")
                    
                    # Verify distance calculation
                    distances_correct = True
                    for atm in data:
                        if "distance_meters" in atm:
                            if atm["distance_meters"] > 1000:
                                distances_correct = False
                                break
                        else:
                            distances_correct = False
                            break
                    
                    if distances_correct:
                        self.log_test("TC_01: Distance calculation", "PASS", "All ATMs within 1000m radius")
                    else:
                        self.log_test("TC_01: Distance calculation", "FAIL", "Some ATMs outside radius or missing distance_meters field")
                        
                else:
                    self.log_test("TC_01: Nearby ATMs", "FAIL", f"No ATMs found or invalid response format", data)
            else:
                self.log_test("TC_01: Nearby ATMs", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_01: Smart Filter", "FAIL", f"Exception: {str(e)}")
    
    def test_tc_02_geofence_lock(self):
        """TC_02: Test Geofence Lock - POST /api/atms/{atm_id}/report"""
        print("=== TESTING TC_02: GEOFENCE LOCK ===")
        
        if not self.atm_id:
            self.log_test("TC_02: Geofence Lock", "FAIL", "No ATM ID available for testing")
            return
        
        # Test 1: Report from WITHIN 50m (should succeed)
        try:
            report_data = {
                "atm_id": self.atm_id,
                "user_id": "test_user_within_geofence",
                "status": "cash",
                "user_lat": WITHIN_GEOFENCE_LAT,
                "user_lng": WITHIN_GEOFENCE_LNG
            }
            
            response = self.post(f"/atms/{self.atm_id}/report", report_data)
            
            if response.status_code == 200:
                data = response.json()
                if "message" in data and "successfully" in data["message"].lower():
                    self.log_test("TC_02: Report within geofence", "PASS", f"Report accepted: {data.get('message')}")
                else:
                    self.log_test("TC_02: Report within geofence", "FAIL", f"Unexpected response", data)
            else:
                self.log_test("TC_02: Report within geofence", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_02: Report within geofence", "FAIL", f"Exception: {str(e)}")
        
        # Test 2: Report from OUTSIDE 50m (should fail with 403)
        try:
            report_data = {
                "atm_id": self.atm_id,
                "user_id": "test_user_outside_geofence",
                "status": "no_cash",
                "user_lat": OUTSIDE_GEOFENCE_LAT,
                "user_lng": OUTSIDE_GEOFENCE_LNG
            }
            
            response = self.post(f"/atms/{self.atm_id}/report", report_data)
            
            if response.status_code == 403:
                data = response.json()
                if "geofence" in data.get("detail", "").lower():
                    self.log_test("TC_02: Report outside geofence", "PASS", f"Correctly blocked: {data.get('detail')}")
                else:
                    self.log_test("TC_02: Report outside geofence", "FAIL", f"Wrong error message", data)
            else:
                self.log_test("TC_02: Report outside geofence", "FAIL", f"Expected 403, got {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_02: Report outside geofence", "FAIL", f"Exception: {str(e)}")
    
    def test_tc_03_majority_voting(self):
        """TC_03: Test Majority Voting - Verify status changes"""
        print("=== TESTING TC_03: MAJORITY VOTING ===")
        
        if not self.atm_id:
            self.log_test("TC_03: Majority Voting", "FAIL", "No ATM ID available for testing")
            return
        
        try:
            # Submit multiple "cash" reports
            for i in range(5):
                report_data = {
                    "atm_id": self.atm_id,
                    "user_id": f"cash_voter_{i}",
                    "status": "cash",
                    "user_lat": WITHIN_GEOFENCE_LAT,
                    "user_lng": WITHIN_GEOFENCE_LNG
                }
                
                response = self.post(f"/atms/{self.atm_id}/report", report_data)
                if response.status_code != 200:
                    self.log_test("TC_03: Submit cash reports", "FAIL", f"Failed to submit report {i}")
                    return
            
            # Wait a moment for processing
            time.sleep(1)
            
            # Check ATM status
            response = self.get(f"/atms/{self.atm_id}/status")
            if response.status_code == 200:
                data = response.json()
                current_status = data.get("current_status")
                if current_status == "green":
                    self.log_test("TC_03: Majority voting result", "PASS", f"ATM status changed to green after cash reports")
                else:
                    self.log_test("TC_03: Majority voting result", "FAIL", f"Expected green, got {current_status}", data)
                    
                # Check status breakdown
                status_breakdown = data.get("status_breakdown", {})
                cash_votes = status_breakdown.get("cash", 0)
                if cash_votes >= 5:
                    self.log_test("TC_03: Vote counting", "PASS", f"Cash votes: {cash_votes}")
                else:
                    self.log_test("TC_03: Vote counting", "FAIL", f"Expected >= 5 cash votes, got {cash_votes}")
                    
            else:
                self.log_test("TC_03: Status check", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_03: Majority Voting", "FAIL", f"Exception: {str(e)}")
    
    def test_tc_04_mock_bank_gateway(self):
        """TC_04: Test Mock Bank Gateway - POST /api/bank/gateway/status"""
        print("=== TESTING TC_04: MOCK BANK GATEWAY ===")
        
        bank_name = "State Bank of India"
        
        # Test 1: Set bank to OFFLINE
        try:
            gateway_data = {
                "bank_name": bank_name,
                "status": "OFFLINE"
            }
            
            response = self.post("/bank/gateway/status", gateway_data)
            if response.status_code == 200:
                data = response.json()
                atms_affected = data.get("atms_affected", 0)
                if atms_affected > 0:
                    self.log_test("TC_04: Set bank OFFLINE", "PASS", f"Successfully set {bank_name} OFFLINE, affected {atms_affected} ATMs")
                else:
                    self.log_test("TC_04: Set bank OFFLINE", "FAIL", f"No ATMs affected", data)
            else:
                self.log_test("TC_04: Set bank OFFLINE", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_04: Set bank OFFLINE", "FAIL", f"Exception: {str(e)}")
        
        # Test 2: Verify ATM status becomes "red"
        try:
            # Get ATMs for this bank
            response = self.get("/atms/all")
            if response.status_code == 200:
                atms = response.json()
                sbi_atms = [atm for atm in atms if atm["bank_name"] == bank_name]
                
                if sbi_atms:
                    red_atms = [atm for atm in sbi_atms if atm["current_status"] == "red"]
                    if len(red_atms) > 0:
                        self.log_test("TC_04: ATM status red", "PASS", f"{len(red_atms)} SBI ATMs now show red status")
                    else:
                        self.log_test("TC_04: ATM status red", "FAIL", f"No SBI ATMs showing red status")
                else:
                    self.log_test("TC_04: Find SBI ATMs", "FAIL", f"No SBI ATMs found")
            else:
                self.log_test("TC_04: Get ATMs", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_04: Verify red status", "FAIL", f"Exception: {str(e)}")
        
        # Test 3: Set bank back to ONLINE
        try:
            gateway_data = {
                "bank_name": bank_name,
                "status": "ONLINE"
            }
            
            response = self.post("/bank/gateway/status", gateway_data)
            if response.status_code == 200:
                data = response.json()
                self.log_test("TC_04: Set bank ONLINE", "PASS", f"Successfully set {bank_name} back ONLINE")
            else:
                self.log_test("TC_04: Set bank ONLINE", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("TC_04: Set bank ONLINE", "FAIL", f"Exception: {str(e)}")
    
    def test_dpdp_compliance(self):
        """Test DPDP Compliance - DELETE /api/user/history"""
        print("=== TESTING DPDP COMPLIANCE ===")
        
        test_user_id = "dpdp_test_user_123"
        
        if not self.atm_id:
            self.log_test("DPDP: User history deletion", "FAIL", "No ATM ID available for creating test data")
            return
        
        # First create some reports with a test user
        try:
            for i in range(3):
                report_data = {
                    "atm_id": self.atm_id,
                    "user_id": test_user_id,
                    "status": "cash",
                    "user_lat": WITHIN_GEOFENCE_LAT,
                    "user_lng": WITHIN_GEOFENCE_LNG
                }
                response = self.post(f"/atms/{self.atm_id}/report", report_data)
                if response.status_code != 200:
                    self.log_test("DPDP: Create test data", "FAIL", f"Failed to create test report {i}")
                    return
            
            self.log_test("DPDP: Create test data", "PASS", f"Created 3 test reports for user {test_user_id}")
            
        except Exception as e:
            self.log_test("DPDP: Create test data", "FAIL", f"Exception: {str(e)}")
            return
        
        # Check user history before deletion
        try:
            response = self.get("/user/history", {"user_id": test_user_id})
            if response.status_code == 200:
                data = response.json()
                reports_before = data.get("total_reports", 0)
                if reports_before > 0:
                    self.log_test("DPDP: Check history before", "PASS", f"User has {reports_before} reports")
                else:
                    self.log_test("DPDP: Check history before", "FAIL", f"User has no reports")
                    return
            else:
                self.log_test("DPDP: Check history before", "FAIL", f"Status code: {response.status_code}")
                return
                
        except Exception as e:
            self.log_test("DPDP: Check history before", "FAIL", f"Exception: {str(e)}")
            return
        
        # Delete user history
        try:
            response = self.delete("/user/history", {"user_id": test_user_id})
            if response.status_code == 200:
                data = response.json()
                reports_deleted = data.get("reports_deleted", 0)
                if reports_deleted > 0:
                    self.log_test("DPDP: Delete user history", "PASS", f"Successfully deleted {reports_deleted} reports")
                else:
                    self.log_test("DPDP: Delete user history", "FAIL", f"No reports deleted", data)
            else:
                self.log_test("DPDP: Delete user history", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("DPDP: Delete user history", "FAIL", f"Exception: {str(e)}")
        
        # Verify deletion
        try:
            response = self.get("/user/history", {"user_id": test_user_id})
            if response.status_code == 200:
                data = response.json()
                reports_after = data.get("total_reports", 0)
                if reports_after == 0:
                    self.log_test("DPDP: Verify deletion", "PASS", f"User history successfully erased")
                else:
                    self.log_test("DPDP: Verify deletion", "FAIL", f"User still has {reports_after} reports")
            else:
                self.log_test("DPDP: Verify deletion", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("DPDP: Verify deletion", "FAIL", f"Exception: {str(e)}")
    
    def test_geofence_check_endpoint(self):
        """Test GET /api/geofence/check"""
        print("=== TESTING GEOFENCE CHECK ENDPOINT ===")
        
        if not self.atm_id:
            self.log_test("Geofence Check", "FAIL", "No ATM ID available for testing")
            return
        
        try:
            # Test within geofence
            params = {
                "atm_id": self.atm_id,
                "user_lat": WITHIN_GEOFENCE_LAT,
                "user_lng": WITHIN_GEOFENCE_LNG
            }
            
            response = self.get("/geofence/check", params)
            if response.status_code == 200:
                data = response.json()
                if data.get("is_within_geofence") and data.get("can_report"):
                    self.log_test("Geofence Check: Within range", "PASS", f"Distance: {data.get('distance_meters')}m")
                else:
                    self.log_test("Geofence Check: Within range", "FAIL", f"Should be within geofence", data)
            else:
                self.log_test("Geofence Check: Within range", "FAIL", f"Status code: {response.status_code}")
                
            # Test outside geofence
            params = {
                "atm_id": self.atm_id,
                "user_lat": OUTSIDE_GEOFENCE_LAT,
                "user_lng": OUTSIDE_GEOFENCE_LNG
            }
            
            response = self.get("/geofence/check", params)
            if response.status_code == 200:
                data = response.json()
                if not data.get("is_within_geofence") and not data.get("can_report"):
                    self.log_test("Geofence Check: Outside range", "PASS", f"Distance: {data.get('distance_meters')}m")
                else:
                    self.log_test("Geofence Check: Outside range", "FAIL", f"Should be outside geofence", data)
            else:
                self.log_test("Geofence Check: Outside range", "FAIL", f"Status code: {response.status_code}")
                
        except Exception as e:
            self.log_test("Geofence Check", "FAIL", f"Exception: {str(e)}")
    
    def run_all_tests(self):
        """Run all test cases"""
        print(f"🚀 Starting NeuroCash Backend API Tests")
        print(f"📍 Base URL: {self.base_url}")
        print(f"🎯 Test Coordinates: Barasat ({BARASAT_LAT}, {BARASAT_LNG})")
        print("="*60)
        
        self.test_basic_endpoints()
        self.test_atm_all_endpoint()
        self.test_tc_01_smart_filter()
        self.test_tc_02_geofence_lock()
        self.test_tc_03_majority_voting()
        self.test_tc_04_mock_bank_gateway()
        self.test_dpdp_compliance()
        self.test_geofence_check_endpoint()
        
        # Summary
        total_tests = len(self.test_results)
        passed_tests = len([t for t in self.test_results if t["status"] == "PASS"])
        failed_tests = total_tests - passed_tests
        
        print("="*60)
        print(f"📊 TEST SUMMARY")
        print(f"   Total Tests: {total_tests}")
        print(f"   ✅ Passed: {passed_tests}")
        print(f"   ❌ Failed: {failed_tests}")
        print(f"   Success Rate: {(passed_tests/total_tests)*100:.1f}%")
        
        if failed_tests > 0:
            print(f"\n❌ FAILED TESTS:")
            for test in self.test_results:
                if test["status"] == "FAIL":
                    print(f"   - {test['test']}: {test['details']}")
        
        return failed_tests == 0

if __name__ == "__main__":
    tester = NeuroCashAPITester()
    success = tester.run_all_tests()
    exit(0 if success else 1)