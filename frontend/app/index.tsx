import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Modal,
  Alert,
  Platform,
  Dimensions,
  ScrollView,
  Linking,
  Image,
  TextInput,
} from 'react-native';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import { makeRedirectUri } from 'expo-auth-session';

WebBrowser.maybeCompleteAuthSession();
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://neurocash.vercel.app";
const { width, height } = Dimensions.get('window');
const isWeb = Platform.OS === 'web';

// Real-time Map Loaders
let MapView: any = null;
let Marker: any = null;
let PROVIDER_GOOGLE: any = null;
if (!isWeb) {
  try {
    const Maps = require('react-native-maps');
    MapView = Maps.default;
    Marker = Maps.Marker;
    PROVIDER_GOOGLE = Maps.PROVIDER_GOOGLE;
  } catch (e) {
    console.log('Map error: ', e);
  }
}

// Types
interface ATM {
  id: string;
  bank_name: string;
  branch_name: string;
  address: string;
  latitude: number;
  longitude: number;
  current_status: string;
  bank_online: boolean;
  last_report_time: string | null;
  distance_meters?: number;
}

interface UserLocation {
  latitude: number;
  longitude: number;
}

interface Notification {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

// Status colors
const STATUS_COLORS: Record<string, string> = {
  green: '#10B981', // Emerald
  yellow: '#F59E0B', // Amber
  red: '#F43F5E', // Rose
  grey: '#94A3B8', // Slate
};

const STATUS_LABELS: Record<string, string> = {
  green: 'Cash Available',
  yellow: 'Low Cash / Queue',
  red: 'No Cash',
  grey: 'Status Unknown',
};

const STATUS_ICONS: Record<string, string> = {
  green: 'checkmark-circle',
  yellow: 'alert-circle',
  red: 'close-circle',
  grey: 'help-circle',
};



// Haversine distance calculation
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export default function NeuroCashApp() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  const redirectUri = makeRedirectUri({
    scheme: 'neurocash',
  });
  console.log("====================================");
  console.log("GOOGLE OAUTH REDIRECT URI:");
  console.log(redirectUri);
  console.log("Ensure this URI is added to Google Cloud Console > APIs & Services > Credentials > Authorized redirect URIs.");
  console.log("====================================");

  const [request, response, promptAsync] = Google.useAuthRequest({
    androidClientId: '1062302145281-5dgmfeac9a8tiprjofsocv99u6ts9jfc.apps.googleusercontent.com',
    iosClientId: '1062302145281-5dgmfeac9a8tiprjofsocv99u6ts9jfc.apps.googleusercontent.com',
    webClientId: '1062302145281-5dgmfeac9a8tiprjofsocv99u6ts9jfc.apps.googleusercontent.com',
    clientId: '1062302145281-5dgmfeac9a8tiprjofsocv99u6ts9jfc.apps.googleusercontent.com',
    redirectUri,
  });

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const token = await AsyncStorage.getItem('googleToken');
        if (token) {
          setIsAuthenticated(true);
        }
      } catch (e) {
      } finally {
        setIsAuthLoading(false);
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    if (response?.type === 'success') {
      const { authentication } = response;
      if (authentication?.accessToken) {
        AsyncStorage.setItem('googleToken', authentication.accessToken).then(() => {
          setIsAuthenticated(true);
          fetchUserProfile();
        });
      }
    }
  }, [response]);

  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [locationName, setLocationName] = useState<string>("Locating...");
  const [atms, setAtms] = useState<ATM[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedATM, setSelectedATM] = useState<ATM | null>(null);
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [isWithinGeofence, setIsWithinGeofence] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [newBankName, setNewBankName] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [atmPhoto, setAtmPhoto] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [userId] = useState(`user_${Date.now()}`);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [nearbyATMPrompt, setNearbyATMPrompt] = useState<ATM | null>(null);
  const promptedATMsRef = useRef<Set<string>>(new Set());
  const [userKarma, setUserKarma] = useState<number>(1.0);
  const [userLevel, setUserLevel] = useState<string>('Bronze');
  const [userPicture, setUserPicture] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const pollingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const lastFetchLocationRef = useRef<UserLocation | null>(null);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await axios.get(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`);
      if (res.data && res.data.length > 0) {
        const result = res.data[0];
        setUserLocation({
          latitude: parseFloat(result.lat),
          longitude: parseFloat(result.lon)
        });
      } else {
        if (!isWeb) {
          Alert.alert("Not Found", "Could not find that location.");
        } else {
          window.alert("Could not find that location.");
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsSearching(false);
    }
  };

  const fetchUserProfile = async () => {
    try {
      const token = await AsyncStorage.getItem('googleToken');
      if (token) {
        const response = await axios.get(`${BACKEND_URL}/api/user/profile`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setUserKarma(response.data.karma_score);
        setUserLevel(response.data.karma_level);
        setUserPicture(response.data.picture || null);
      }
    } catch (e) {
      console.log('Error fetching user profile:', e);
    }
  };

  // Default location: Champadali More, Barasat
  const defaultLocation = {
    latitude: 22.7246,
    longitude: 88.4844,
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchUserProfile();
      fetchNotifications();
    }
  }, [isAuthenticated]);

  const fetchLocationWithPermission = useCallback(async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!isWeb) {
          Alert.alert('Permission Denied', 'Location permission is required. Using default location.');
        } else {
          window.alert('Permission Denied: Location permission is required. Using default location.');
        }
        setUserLocation(defaultLocation);
        return;
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      setUserLocation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      });

      // Start watching location for live updates (native only)
      if (!isWeb) {
        if (locationSubscription.current) {
          locationSubscription.current.remove();
        }
        locationSubscription.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 5000,
            distanceInterval: 10,
          },
          (newLocation) => {
            setUserLocation({
              latitude: newLocation.coords.latitude,
              longitude: newLocation.coords.longitude,
            });
          }
        );
      }
    } catch (error) {
      console.error('Location error:', error);
      setUserLocation(defaultLocation);
    }
  }, []);

  const askForLocationPermission = useCallback(() => {
    if (isWeb) {
      const confirm = window.confirm("NeuroCash needs your location to find nearby ATMs. Allow access?");
      if (confirm) {
        fetchLocationWithPermission();
      } else {
        setUserLocation(defaultLocation);
      }
    } else {
      Alert.alert(
        "Location Access",
        "NeuroCash needs your location to find nearby ATMs. Allow access?",
        [
          { text: "Deny", onPress: () => setUserLocation(defaultLocation), style: "cancel" },
          { text: "Allow", onPress: fetchLocationWithPermission }
        ]
      );
    }
  }, [fetchLocationWithPermission]);

  // Reverse Geocode user location for human readability
  useEffect(() => {
    const fetchLocationName = async () => {
      if (!userLocation) return;
      try {
        if (isWeb) {
          // Use OpenStreetMap Nominatim for Web to avoid expo-location API key issues
          const res = await axios.get(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${userLocation.latitude}&lon=${userLocation.longitude}&zoom=18&addressdetails=1`);
          if (res.data && res.data.address) {
            const addr = res.data.address;
            const name = addr.neighbourhood || addr.suburb || addr.city_district || addr.city || addr.town || 'Unknown Location';
            const shortName = addr.road ? `${addr.road}, ${name}` : name;
            setLocationName(shortName);
          } else {
            setLocationName(`${userLocation.latitude.toFixed(4)}, ${userLocation.longitude.toFixed(4)}`);
          }
        } else {
          const geocode = await Location.reverseGeocodeAsync({
            latitude: userLocation.latitude,
            longitude: userLocation.longitude,
          });
          if (geocode.length > 0) {
            const place = geocode[0];
            const name = place.district || place.city || place.subregion || place.region || 'Unknown Location';
            const shortName = place.name && place.name !== name ? `${place.name}, ${name}` : name;
            setLocationName(shortName);
          } else {
            setLocationName("Location Name Unavailable");
          }
        }
      } catch (error) {
        setLocationName(`${userLocation.latitude.toFixed(4)}, ${userLocation.longitude.toFixed(4)}`);
      }
    };
    fetchLocationName();
  }, [userLocation?.latitude, userLocation?.longitude]);

  // Start live location tracking
  useEffect(() => {
    askForLocationPermission();

    if (isWeb && 'Notification' in window) {
      if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }

    return () => {
      if (locationSubscription.current) {
        locationSubscription.current.remove();
      }
    };
  }, [askForLocationPermission]);

  const initialLoadDone = useRef(false);

  // Fetch nearby ATMs
  const fetchNearbyATMs = useCallback(async (force = false) => {
    if (!userLocation) return;
    
    // Throttle API requests: only fetch if forced or moved > 200m
    if (!force && lastFetchLocationRef.current) {
      const dist = haversineDistance(
        userLocation.latitude, userLocation.longitude,
        lastFetchLocationRef.current.latitude, lastFetchLocationRef.current.longitude
      );
      if (dist < 200) return;
    }
    lastFetchLocationRef.current = userLocation;
    
    if (!initialLoadDone.current) {
      setLoading(true);
    }
    
    try {
      const response = await axios.get(`${BACKEND_URL}/api/atms/nearby`, {
        params: {
          lat: userLocation.latitude,
          lng: userLocation.longitude,
          radius: 1000, 
        },
      });

      const fetchedAtms = response.data.map((atm: any) => ({
        ...atm,
        distance_meters: atm.distance_meters || haversineDistance(
          userLocation.latitude, userLocation.longitude,
          atm.latitude, atm.longitude
        )
      }));

      // Strictly sort the real ATMs nearest to furthest
      fetchedAtms.sort((a: any, b: any) => (a.distance_meters || 0) - (b.distance_meters || 0));
      
      setAtms(fetchedAtms);
      setLastRefresh(new Date());
      initialLoadDone.current = true;

      if (fetchedAtms.length > 0) {
        const closest = fetchedAtms[0];
        
        if (closest.distance_meters <= 50 && !promptedATMsRef.current.has(closest.id)) {
          promptedATMsRef.current.add(closest.id);
          
          if (isWeb && 'Notification' in window && Notification.permission === 'granted') {
            const notif = new Notification("🏦 ATM Nearby!", {
              body: `You are at ${closest.bank_name}. Report its cash status to earn Karma!`,
            });
            notif.onclick = () => { window.focus(); };
          }
          
          setNearbyATMPrompt(closest);
          
        } else if (closest.distance_meters > 100) {
          promptedATMsRef.current.delete(closest.id);
        }
      }
    } catch (error) {
      console.error('Error fetching ATMs from backend:', error);
      if (!isWeb) {
        Alert.alert('Error', 'Could not fetch ATMs. Please check your connection.');
      }
    } finally {
      setLoading(false);
    }
  }, [userLocation]);

  // Initial fetch and 30-second polling
  useEffect(() => {
    if (userLocation) {
      // Pass force=false on movement updates, won't blindly refetch if <200m
      fetchNearbyATMs(false);

      if (pollingInterval.current) {
        clearInterval(pollingInterval.current);
      }
      
      pollingInterval.current = setInterval(() => {
        fetchNearbyATMs(true); // force fetch on interval
      }, 30000);

      return () => {
        if (pollingInterval.current) {
          clearInterval(pollingInterval.current);
        }
      };
    }
  }, [userLocation, fetchNearbyATMs]);

  // Check for nearby ATMs and prompt user
  useEffect(() => {
    if (!userLocation || atms.length === 0) return;

    for (const atm of atms) {
      const distance = haversineDistance(
        userLocation.latitude,
        userLocation.longitude,
        atm.latitude,
        atm.longitude
      );

      if (distance <= 50 && !promptedATMsRef.current.has(atm.id)) {
        setNearbyATMPrompt(atm);
        promptedATMsRef.current.add(atm.id);
        break;
      }
    }
  }, [userLocation, atms]);

  // Check geofence when ATM is selected
  useEffect(() => {
    if (selectedATM && userLocation) {
      const distance = haversineDistance(
        userLocation.latitude,
        userLocation.longitude,
        selectedATM.latitude,
        selectedATM.longitude
      );
      setIsWithinGeofence(distance <= 50);
    }
  }, [selectedATM, userLocation]);

  const handleATMPress = (atm: ATM) => {
    setSelectedATM(atm);
    setReportModalVisible(true);
  };

  const reportStatus = async (status: string) => {
    if (!selectedATM || !userLocation) return;

    setSubmitting(true);
    try {
      const token = await AsyncStorage.getItem('googleToken');
      await axios.post(`${BACKEND_URL}/api/atms/${selectedATM.id}/report`, { status }, {
        headers: { Authorization: token ? `Bearer ${token}` : {} }
      });
      if (Platform.OS !== 'web') {
        Alert.alert("Success", "Status updated! You've earned 10 points.");
      } else {
        window.alert("Success! Status updated. You've earned 10 points.");
      }
      setReportModalVisible(false);
      fetchNearbyATMs(true);
    } catch (error) {
      console.error('Error reporting status:', error);
      if (Platform.OS !== 'web') {
        Alert.alert("Error", "Could not submit report.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubscribe = async () => {
    if (!selectedATM) return;
    try {
      const token = await AsyncStorage.getItem('googleToken');
      await axios.post(`${BACKEND_URL}/api/atms/${selectedATM.id}/subscribe`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (Platform.OS !== 'web') {
        Alert.alert("Subscribed", "We will notify you as soon as cash is reported at this ATM.");
      } else {
        window.alert("Subscribed! We will notify you as soon as cash is reported at this ATM.");
      }
      fetchNotifications();
    } catch (error) {
      console.error('Error subscribing:', error);
    }
  };

  const markAsRead = async (id: string) => {
    try {
      const token = await AsyncStorage.getItem('googleToken');
      await axios.post(`${BACKEND_URL}/api/user/notifications/${id}/read`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setNotifications(notifications.map(n => n.id === id ? { ...n, read: true } : n));
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      if (Platform.OS !== 'web') {
        Alert.alert("Permission Denied", "We need camera access to verify ATMs.");
      } else {
        window.alert("Permission Denied: We need camera access to verify ATMs.");
      }
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.5,
      base64: true,
    });

    if (!result.canceled) {
      setAtmPhoto(result.assets[0].uri);
    }
  };

  const handleAddATM = async () => {
    if (!newBankName || !newBranchName || !userLocation) {
      if (Platform.OS !== 'web') Alert.alert("Error", "Please fill all fields.");
      return;
    }

    if (!atmPhoto) {
      if (Platform.OS !== 'web') Alert.alert("Photo Required", "You must take a photo of the ATM from outside to verify its location.");
      return;
    }

    setIsAdding(true);
    try {
      const token = await AsyncStorage.getItem('googleToken');
      const response = await axios.post(`${BACKEND_URL}/api/atms/add`, {
        bank_name: newBankName,
        branch_name: newBranchName,
        latitude: userLocation.latitude,
        longitude: userLocation.longitude,
        address: locationName,
        image_base64: atmPhoto
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const { verification_status } = response.data;
      const successMsg = verification_status === 'verified' 
        ? "ATM added and instantly verified by your high Karma!" 
        : "ATM added! It will appear as 'Pending' until verified by the community.";

      if (Platform.OS !== 'web') {
        Alert.alert("Success!", `${successMsg} (+50 Points)`);
      } else {
        window.alert(`Success! ${successMsg} (+50 Points)`);
      }
      
      setAddModalVisible(false);
      setNewBankName('');
      setNewBranchName('');
      setAtmPhoto(null);
      fetchNearbyATMs(true);
      fetchUserProfile();
    } catch (error: any) {
      console.error('Error adding ATM:', error);
      const detail = error.response?.data?.detail || "Could not add ATM.";
      if (Platform.OS !== 'web') Alert.alert("Error", detail);
    } finally {
      setIsAdding(false);
    }
  };

  const handleConfirmATM = async (exists: boolean) => {
    if (!selectedATM) return;
    try {
      const token = await AsyncStorage.getItem('googleToken');
      const response = await axios.post(`${BACKEND_URL}/api/atms/${selectedATM.id}/confirm`, { exists }, {
        headers: { Authorization: `Bearer ${token}` },
        params: { exists } // API uses query params or body depending on setup, I'll match my endpoint
      });
      
      if (Platform.OS !== 'web') {
        Alert.alert("Vote Recorded", response.data.message);
      } else {
        window.alert(response.data.message);
      }
      setDetailModalVisible(false);
      fetchNearbyATMs(true);
    } catch (error) {
      console.error('Error confirming ATM:', error);
    }
  };

  const fetchNotifications = async () => {
    try {
      const token = await AsyncStorage.getItem('googleToken');
      if (token) {
        const response = await axios.get(`${BACKEND_URL}/api/user/notifications`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setNotifications(response.data);
      }
    } catch (error) {
      console.error('Error fetching notifications:', error);
    }
  };

  const openInGoogleMaps = (atm: ATM) => {
    let url = `https://www.google.com/maps/dir/?api=1&destination=${atm.latitude},${atm.longitude}`;
    if (userLocation) {
      url = `https://www.google.com/maps/dir/?api=1&origin=${userLocation.latitude},${userLocation.longitude}&destination=${atm.latitude},${atm.longitude}`;
    }
    Linking.openURL(url);
  };

  const getStatusColor = (status: string): string => {
    return STATUS_COLORS[status] || STATUS_COLORS.grey;
  };

  // Render nearby ATM prompt modal
  const renderNearbyPrompt = () => {
    if (!nearbyATMPrompt || reportModalVisible) return null;

    const distance = userLocation
      ? haversineDistance(userLocation.latitude, userLocation.longitude, nearbyATMPrompt.latitude, nearbyATMPrompt.longitude)
      : 0;

    return (
      <Modal visible={true} animationType="slide" transparent onRequestClose={() => setNearbyATMPrompt(null)}>
        <View style={styles.promptOverlay}>
          <View style={styles.promptContent}>
            <View style={styles.promptIcon}>
              <Ionicons name="location" size={32} color="#4F46E5" />
            </View>
            <Text style={styles.promptTitle}>You're near an ATM!</Text>
            <Text style={styles.promptSubtitle}>{nearbyATMPrompt.bank_name} - {nearbyATMPrompt.branch_name}</Text>
            <Text style={styles.promptDistance}>{distance.toFixed(0)}m away</Text>
            <Text style={styles.promptQuestion}>Would you like to report its cash status?</Text>

            <View style={styles.promptButtons}>
              <TouchableOpacity
                style={[styles.promptButton, styles.promptButtonPrimary]}
                onPress={() => {
                  setNearbyATMPrompt(null);
                  setSelectedATM(nearbyATMPrompt);
                  setReportModalVisible(true);
                }}
              >
                <Ionicons name="checkmark" size={20} color="#FFF" />
                <Text style={styles.promptButtonTextPrimary}>Report Status</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.promptButton, styles.promptButtonSecondary]}
                onPress={() => setNearbyATMPrompt(null)}
              >
                <Text style={styles.promptButtonTextSecondary}>Maybe Later</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Render ATM detail modal
  const renderATMModal = () => {
    if (!selectedATM) return null;

    return (
      <Modal visible={reportModalVisible} animationType="slide" transparent onRequestClose={() => setReportModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.detailContent}>
            <View style={styles.sheetHandle} />
            <View style={styles.detailHeader}>
              <View style={styles.detailTitleWrapper}>
                <Text style={styles.detailBankName}>{selectedATM.bank_name}</Text>
                <Text style={styles.detailBranchName}>{selectedATM.branch_name}</Text>
              </View>
              <TouchableOpacity style={styles.closeButton} onPress={() => setReportModalVisible(false)}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            <View style={styles.detailStatusSection}>
              <View style={[styles.detailStatusBadge, { backgroundColor: getStatusColor(selectedATM.current_status) + '20' }]}>
                <Ionicons name={STATUS_ICONS[selectedATM.current_status] as any} size={24} color={getStatusColor(selectedATM.current_status)} />
                <Text style={[styles.detailStatusText, { color: getStatusColor(selectedATM.current_status) }]}>
                  {STATUS_LABELS[selectedATM.current_status]}
                </Text>
              </View>
              {selectedATM.current_status !== 'green' && (
                <TouchableOpacity style={styles.notifyButton} onPress={handleSubscribe}>
                  <Ionicons name="notifications-outline" size={18} color="#6366F1" />
                  <Text style={styles.notifyButtonText}>Notify Me When Cash is Back</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.infoSection}>
              <View style={styles.infoRow}>
                <Ionicons name="location-outline" size={20} color="#6B7280" />
                <Text style={styles.infoText}>{selectedATM.address}</Text>
              </View>
              
              <View style={[styles.geofenceStatus, { backgroundColor: isWithinGeofence ? '#DCFCE7' : '#FEE2E2' }]}>
                <Ionicons
                  name={isWithinGeofence ? 'checkmark-circle' : 'close-circle'}
                  size={24}
                  color={isWithinGeofence ? '#22C55E' : '#EF4444'}
                />
                <View style={styles.geofenceTextContainer}>
                  <Text style={[styles.geofenceTitle, { color: isWithinGeofence ? '#166534' : '#991B1B' }]}>
                    {isWithinGeofence ? 'Within Range' : 'Too Far to Report'}
                  </Text>
                  <Text style={[styles.geofenceSubtext, { color: isWithinGeofence ? '#166534' : '#991B1B' }]}>
                    {isWithinGeofence ? 'You can report status' : 'Move closer (within 50m)'}
                  </Text>
                </View>
              </View>

              {selectedATM.verification_status === 'pending' && (
                <View style={styles.verificationCard}>
                  <Text style={styles.verificationTitle}>👥 Community Vetting</Text>
                  <Text style={styles.verificationSubtitle}>This location is unverified. Is the ATM really here?</Text>
                  <View style={styles.voteButtons}>
                    <TouchableOpacity style={[styles.voteBtn, styles.voteYes]} onPress={() => handleConfirmATM(true)}>
                      <Ionicons name="thumbs-up" size={18} color="#FFF" />
                      <Text style={styles.voteText}>Yes, it exists</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.voteBtn, styles.voteNo]} onPress={() => handleConfirmATM(false)}>
                      <Ionicons name="thumbs-down" size={18} color="#FFF" />
                      <Text style={styles.voteText}>Fake Location</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              <TouchableOpacity style={styles.directionsButton} onPress={() => openInGoogleMaps(selectedATM)}>
                <Ionicons name="navigate" size={20} color="#FFF" />
                <Text style={styles.directionsButtonText}>Get Directions</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.reportTitle}>Report ATM Status</Text>
            <View style={styles.reportButtonsGrid}>
              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#22C55E' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('green')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="checkmark-circle" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>Cash Available</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#EAB308' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('yellow')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="alert-circle" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>Low Cash</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#F97316' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('grey')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="people" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>Long Queue</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#EF4444' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('red')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="close-circle" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>No Cash</Text>
              </TouchableOpacity>
            </View>

            {submitting && <ActivityIndicator size="small" color="#4F46E5" style={{ marginTop: 16 }} />}
          </View>
        </View>
      </Modal>
    );
  };

  const renderAddATMModal = () => {
    return (
      <Modal visible={addModalVisible} animationType="slide" transparent onRequestClose={() => setAddModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.detailContent}>
            <View style={styles.sheetHandle} />
            <View style={styles.detailHeader}>
              <View style={styles.detailTitleWrapper}>
                <Text style={styles.detailBankName}>Add New ATM</Text>
                <Text style={styles.detailBranchName}>Help others find cash by adding missing ATMs</Text>
              </View>
              <TouchableOpacity style={styles.closeButton} onPress={() => setAddModalVisible(false)}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            <View style={styles.addForm}>
              <Text style={styles.inputLabel}>Bank Name</Text>
              <TextInput 
                style={styles.formInput} 
                placeholder="e.g. HDFC Bank, SBI, etc." 
                placeholderTextColor="#94A3B8"
                value={newBankName}
                onChangeText={setNewBankName}
              />

              <Text style={styles.inputLabel}>Branch / Location Name</Text>
              <TextInput 
                style={styles.formInput} 
                placeholder="e.g. Airport Terminal 2, MG Road" 
                placeholderTextColor="#94A3B8"
                value={newBranchName}
                onChangeText={setNewBranchName}
              />

              <View style={styles.locationSummary}>
                <Ionicons name="location" size={18} color="#6366F1" />
                <Text style={styles.locationSummaryText}>Capturing your current GPS location...</Text>
              </View>

              <TouchableOpacity style={styles.photoButton} onPress={handlePickImage}>
                {atmPhoto ? (
                  <View style={styles.photoPreviewContainer}>
                    <Image source={{ uri: atmPhoto }} style={styles.photoPreview} />
                    <View style={styles.photoSuccessOverlay}>
                      <Ionicons name="checkmark-circle" size={24} color="#10B981" />
                      <Text style={styles.photoSuccessText}>Photo Captured</Text>
                    </View>
                  </View>
                ) : (
                  <>
                    <Ionicons name="camera" size={32} color="#6366F1" />
                    <Text style={styles.photoButtonText}>Take ATM Photo from Outside</Text>
                    <Text style={styles.photoSubtext}>Required for verification</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.directionsButton, (!newBankName || !newBranchName || !atmPhoto) && { opacity: 0.6 }]} 
                onPress={handleAddATM}
                disabled={isAdding}
              >
                {isAdding ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <>
                    <Ionicons name="add-circle" size={20} color="#FFF" />
                    <Text style={styles.directionsButtonText}>Verify & Add ATM (+50 Pts)</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Render list view
  const renderListView = () => {
    return (
      <ScrollView style={styles.listContainer} showsVerticalScrollIndicator={false}>
        
        {/* Real-time Location Map */}
        {userLocation && (
          <View style={{ height: 250, width: '100%', backgroundColor: '#E5E7EB', borderRadius: 16, overflow: 'hidden', marginBottom: 16 }}>
            {isWeb ? (
              <iframe
                width="100%"
                height="100%"
                frameBorder="0"
                style={{ border: 0 }}
                srcDoc={`
                  <!DOCTYPE html>
                  <html>
                  <head>
                      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
                      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
                      <style>
                          body { margin: 0; padding: 0; }
                          #map { width: 100vw; height: 100vh; }
                          .pulsing-marker {
                              filter: drop-shadow(0 0 8px rgba(16, 185, 129, 0.8));
                              animation: pulse-glow 2s infinite;
                          }
                          .pending-marker {
                              opacity: 0.5;
                              filter: grayscale(80%);
                          }
                          @keyframes pulse-glow {
                              0% { transform: scale(1); filter: drop-shadow(0 0 5px rgba(16, 185, 129, 0.5)); }
                              50% { transform: scale(1.1); filter: drop-shadow(0 0 15px rgba(16, 185, 129, 0.9)); }
                              100% { transform: scale(1); filter: drop-shadow(0 0 5px rgba(16, 185, 129, 0.5)); }
                          }
                      </style>
                  </head>
                  <body>
                      <div id="map"></div>
                      <script>
                          var map = L.map('map').setView([${userLocation.latitude}, ${userLocation.longitude}], 14);
                          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                              attribution: '© OpenStreetMap contributors'
                          }).addTo(map);
                          
                          // User marker
                          L.marker([${userLocation.latitude}, ${userLocation.longitude}]).addTo(map)
                              .bindPopup('<b>You are here</b><br>${locationName.replace(/'/g, "\\'")}');
                  
                          // ATM markers
                          var atms = ${JSON.stringify(atms)};
                          var now = new Date();
                          var colors = {
                              'green': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
                              'yellow': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-yellow.png',
                              'red': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
                              'grey': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-grey.png'
                          };
                  
                          atms.forEach(function(atm) {
                              var isFresh = false;
                              if (atm.last_report_time) {
                                  var reportTime = new Date(atm.last_report_time);
                                  var diffMins = (now - reportTime) / (1000 * 60);
                                  if (diffMins <= 30 && atm.current_status === 'green') {
                                      isFresh = true;
                                  }
                              }

                              var isPending = atm.verification_status === 'pending';

                              var icon = new L.Icon({
                                  iconUrl: colors[atm.current_status] || colors['grey'],
                                  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                                  iconSize: [25, 41],
                                  iconAnchor: [12, 41],
                                  popupAnchor: [1, -34],
                                  shadowSize: [41, 41],
                                  className: (isFresh ? 'pulsing-marker ' : '') + (isPending ? 'pending-marker' : '')
                              });
                              L.marker([atm.latitude, atm.longitude], {icon: icon}).addTo(map)
                                  .bindPopup('<b>' + atm.bank_name + '</b><br>' + atm.branch_name + (isPending ? '<br><span style="color: #F59E0B;">⚠️ Unverified</span>' : '') + '<br><b>Status:</b> ' + atm.current_status + (isFresh ? '<br><span style="color: #10B981; font-weight: bold;">⚡ Just Verified!</span>' : ''));
                          });
                      </script>
                  </body>
                  </html>
                `}
                allowFullScreen
              ></iframe>
            ) : MapView ? (
              <MapView
                provider={PROVIDER_GOOGLE}
                style={{ flex: 1 }}
                initialRegion={{
                  latitude: userLocation.latitude,
                  longitude: userLocation.longitude,
                  latitudeDelta: 0.04,
                  longitudeDelta: 0.04,
                }}
                showsUserLocation={true}
              >
                {/* Explicit Marker for User Location */}
                <Marker
                  coordinate={{ latitude: userLocation.latitude, longitude: userLocation.longitude }}
                  title="You"
                  description={locationName}
                  pinColor="#4F46E5"
                  zIndex={999}
                />
                
                {atms.map((atm) => (
                  <Marker
                    key={atm.id}
                    coordinate={{ latitude: atm.latitude, longitude: atm.longitude }}
                    title={`${atm.bank_name} - ${STATUS_LABELS[atm.current_status]}`}
                    description={atm.branch_name}
                    pinColor={atm.current_status === 'green' ? 'green' : atm.current_status === 'red' ? 'red' : atm.current_status === 'yellow' ? 'yellow' : 'navy'}
                    onPress={() => handleATMPress(atm)}
                  />
                ))}
              </MapView>
            ) : (
               <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                  <Text>Map not available</Text>
               </View>
            )}
          </View>
        )}

        {atms.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="location-outline" size={64} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>No ATMs Found</Text>
            <Text style={styles.emptySubtitle}>No ATMs within 1km of your location</Text>
          </View>
        ) : (
          atms.map((atm) => {
            const distance = userLocation
              ? haversineDistance(userLocation.latitude, userLocation.longitude, atm.latitude, atm.longitude)
              : atm.distance_meters || 0;
            const canReport = distance <= 50;

            return (
              <TouchableOpacity key={atm.id} style={styles.atmCard} onPress={() => handleATMPress(atm)}>
                <View style={styles.atmCardHeader}>
                  <View style={[styles.statusIndicator, { backgroundColor: getStatusColor(atm.current_status) }]}>
                    <Ionicons name={STATUS_ICONS[atm.current_status] as any} size={20} color="#FFF" />
                  </View>
                  <View style={styles.atmCardInfo}>
                    <Text style={styles.atmBankName}>{atm.bank_name}</Text>
                    <Text style={styles.atmBranchName}>{atm.branch_name}</Text>
                  </View>
                  {canReport && (
                    <View style={styles.inRangeBadge}>
                      <Ionicons name="location" size={14} color="#22C55E" />
                      <Text style={styles.inRangeText}>In Range</Text>
                    </View>
                  )}
                </View>
                <View style={styles.atmCardBody}>
                  <View style={styles.atmInfoRow}>
                    <Ionicons name="location-outline" size={16} color="#6B7280" />
                    <Text style={styles.atmAddress} numberOfLines={1}>{atm.address}</Text>
                  </View>
                  <View style={styles.atmInfoRow}>
                    <Ionicons name="navigate-outline" size={16} color="#4F46E5" />
                    <Text style={styles.atmDistance}>{distance.toFixed(0)}m away</Text>
                  </View>
                </View>
                <View style={styles.atmCardFooter}>
                  <View style={[styles.statusBadge, { backgroundColor: getStatusColor(atm.current_status) + '20' }]}>
                    <Text style={[styles.statusBadgeText, { color: getStatusColor(atm.current_status) }]}>
                      {STATUS_LABELS[atm.current_status]}
                    </Text>
                  </View>
                  {!atm.bank_online && (
                    <View style={styles.offlineBadge}>
                      <Ionicons name="warning" size={14} color="#EF4444" />
                      <Text style={styles.offlineBadgeText}>Offline</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    );
  };

  // Loading state
  if (isAuthLoading || (isAuthenticated && (loading || !userLocation))) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <View style={styles.loadingContent}>
          <View style={styles.loadingIconContainer}>
            <Ionicons name="cash" size={48} color="#4F46E5" />
          </View>
          <Text style={styles.loadingTitle}>NeuroCash</Text>
          <Text style={styles.loadingSubtitle}>ATM Liquidity Mapper</Text>
          <ActivityIndicator size="large" color="#4F46E5" style={{ marginTop: 24 }} />
          <Text style={styles.loadingText}>{isAuthLoading ? 'Verifying session...' : 'Getting your location...'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!isAuthenticated && !isAuthLoading) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <View style={styles.authContent}>
          <View style={styles.authIconContainer}>
            <Ionicons name="cash" size={48} color="#4F46E5" />
          </View>
          <Text style={styles.authTitle}>Welcome to NeuroCash</Text>
          <Text style={styles.authSubtitle}>Find and report ATM liquidity in real-time.</Text>
          
          <TouchableOpacity 
            style={styles.googleButton} 
            disabled={!request}
            onPress={() => promptAsync()}
          >
            <Ionicons name="logo-google" size={24} color="#FFF" />
            <Text style={styles.googleButtonText}>Sign in with Google</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Notifications Modal */}
      <Modal visible={showNotifications} animationType="fade" transparent onRequestClose={() => setShowNotifications(false)}>
        <View style={styles.modalOverlayCenter}>
          <View style={styles.notifContent}>
            <View style={styles.notifHeader}>
              <Text style={styles.notifTitle}>Notifications</Text>
              <TouchableOpacity onPress={() => setShowNotifications(false)}>
                <Ionicons name="close" size={24} color="#F8FAFC" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.notifList}>
              {notifications.length === 0 ? (
                <Text style={styles.noNotifText}>No recent alerts</Text>
              ) : (
                notifications.map(n => (
                  <TouchableOpacity key={n.id} style={[styles.notifItem, !n.read && styles.notifItemUnread]} onPress={() => markAsRead(n.id)}>
                    <View style={styles.notifIndicator} />
                    <View style={styles.notifInfo}>
                      <Text style={styles.notifMsgTitle}>{n.title}</Text>
                      <Text style={styles.notifMsg}>{n.message}</Text>
                      <Text style={styles.notifTime}>{new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.logoContainer}>
            <Ionicons name="cash" size={24} color="#4F46E5" />
          </View>
          <View>
            <Text style={styles.headerTitle}>NeuroCash</Text>
            <View style={styles.liveIndicator}>
              <View style={styles.liveDot} />
              <Text style={styles.headerSubtitle}>{atms.length} ATMs Live</Text>
            </View>
          </View>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.karmaBadge, 
            userLevel === 'Gold' ? styles.karmaGold : 
            userLevel === 'Silver' ? styles.karmaSilver : 
            styles.karmaBronze
          ]}>
            <Ionicons name="star" size={12} color="#FFF" />
            <Text style={styles.karmaText}>{userLevel} ({userKarma.toFixed(1)})</Text>
          </View>
          <TouchableOpacity onPress={() => setShowNotifications(true)} style={styles.notificationBtn}>
            <Ionicons name="notifications" size={20} color="#F8FAFC" />
            {notifications.filter(n => !n.read).length > 0 && (
              <View style={styles.notifBadge} />
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/profile')} style={styles.profileButton}>
            {userPicture ? (
              <Image source={{ uri: userPicture }} style={{width: 28, height: 28, borderRadius: 14}} />
            ) : (
              <Ionicons name="person-circle" size={28} color="#4F46E5" />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <View style={styles.searchInputWrapper}>
          <Ionicons name="search" size={18} color="#94A3B8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search city or area..."
            placeholderTextColor="#94A3B8"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
          {searchQuery ? (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color="#94A3B8" />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity onPress={handleSearch} style={styles.searchActionBtn} disabled={isSearching}>
          {isSearching ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="arrow-forward" size={20} color="#FFF" />}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setAddModalVisible(true)} style={styles.addAtmBtn}>
          <Ionicons name="add" size={24} color="#FFF" />
        </TouchableOpacity>
        <TouchableOpacity onPress={fetchLocationWithPermission} style={styles.myLocationBtn}>
          <Ionicons name="locate" size={20} color="#6366F1" />
        </TouchableOpacity>
      </View>

      {/* Location Bar */}
      <View style={styles.locationBar}>
        <Ionicons name="location" size={16} color="#4F46E5" />
        <Text style={styles.locationText}>
          Current Location: {locationName}
        </Text>
        <View style={styles.locationDivider} />
        <Text style={styles.locationText}>1km radius</Text>
        {!isWeb && <View style={[styles.liveDotSmall, { marginLeft: 8 }]} />}
        {!isWeb && <Text style={styles.liveTextSmall}>Live</Text>}
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {Object.entries(STATUS_COLORS).map(([key, color]) => (
          <View key={key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={styles.legendText}>{key === 'grey' ? 'Unknown' : key.charAt(0).toUpperCase() + key.slice(1)}</Text>
          </View>
        ))}
      </View>

      {/* Content - List View */}
      {renderListView()}

      {/* Info Bar */}
      <View style={styles.infoBar}>
        <Text style={styles.infoBarText}>
          Updated: {lastRefresh.toLocaleTimeString()} • Auto-refresh every 30s
        </Text>
      </View>

      {/* Modals */}
      {renderNearbyPrompt()}
      {renderATMModal()}
      {renderAddATMModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  authContainer: { flex: 1, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center', padding: 24 },
  authContent: { alignItems: 'center', backgroundColor: '#FFF', padding: 32, borderRadius: 24, width: '100%', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 4 },
  authIconContainer: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#EEF2FF', justifyContent: 'center', alignItems: 'center', marginBottom: 24 },
  authTitle: { fontSize: 24, fontWeight: '700', color: '#1F2937', marginBottom: 8, textAlign: 'center' },
  authSubtitle: { fontSize: 16, color: '#6B7280', textAlign: 'center', marginBottom: 32 },
  googleButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#4285F4', paddingVertical: 14, paddingHorizontal: 24, borderRadius: 12, width: '100%', justifyContent: 'center' },
  googleButtonText: { color: '#FFF', fontSize: 16, fontWeight: '600', marginLeft: 12 },
  container: { flex: 1, backgroundColor: '#0F172A' },
  loadingContainer: { flex: 1, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center' },
  loadingContent: { alignItems: 'center' },
  loadingIconContainer: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#EEF2FF', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  loadingTitle: { fontSize: 28, fontWeight: '700', color: '#1F2937' },
  loadingSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  loadingText: { marginTop: 16, fontSize: 14, color: '#6B7280' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#1E293B', borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  logoContainer: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#F8FAFC', letterSpacing: -0.5 },
  headerSubtitle: { fontSize: 12, color: '#94A3B8', fontWeight: '500' },
  liveIndicator: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981', marginRight: 6 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  profileButton: { width: 38, height: 38, justifyContent: 'center', alignItems: 'center', backgroundColor: '#334155', borderRadius: 19, borderWidth: 1.5, borderColor: '#475569' },
  karmaBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, gap: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
  karmaGold: { backgroundColor: '#F59E0B' },
  karmaSilver: { backgroundColor: '#94A3B8' },
  karmaBronze: { backgroundColor: '#B45309' },
  karmaText: { color: '#FFF', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  searchContainer: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#1E293B', alignItems: 'center' },
  searchInputWrapper: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderWidth: 1, borderColor: '#334155', borderRadius: 14, paddingHorizontal: 12, height: 48, marginRight: 8 },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: '#F1F5F9', height: '100%' },
  searchActionBtn: { backgroundColor: '#6366F1', height: 48, width: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 8, shadowColor: '#6366F1', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  addAtmBtn: { backgroundColor: '#10B981', height: 48, width: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 8, shadowColor: '#10B981', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  searchBtnText: { color: '#FFF', fontWeight: '700', fontSize: 14 },
  myLocationBtn: { width: 48, height: 48, backgroundColor: '#334155', borderRadius: 14, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#475569' },
  locationBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, backgroundColor: '#312E81' },
  locationText: { fontSize: 12, color: '#E0E7FF', marginLeft: 6, fontWeight: '600' },
  locationDivider: { width: 1, height: 14, backgroundColor: '#4338CA', marginHorizontal: 12 },
  liveDotSmall: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#10B981', shadowColor: '#10B981', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 4 },
  liveTextSmall: { fontSize: 11, color: '#10B981', fontWeight: '800', marginLeft: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  legend: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, backgroundColor: '#1E293B', borderBottomWidth: 1, borderBottomColor: '#334155' },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  legendText: { fontSize: 11, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase' },
  listContainer: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  emptyState: { alignItems: 'center', paddingVertical: 64 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#F8FAFC', marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: '#94A3B8', marginTop: 4, textAlign: 'center' },
  atmCard: { backgroundColor: '#1E293B', borderRadius: 20, padding: 18, marginBottom: 16, borderWidth: 1, borderColor: '#334155', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 10, elevation: 4 },
  atmCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  statusIndicator: { width: 48, height: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  atmCardInfo: { flex: 1 },
  atmBankName: { fontSize: 18, fontWeight: '700', color: '#F8FAFC' },
  atmBranchName: { fontSize: 13, color: '#94A3B8', marginTop: 4 },
  inRangeBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(16, 185, 129, 0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(16, 185, 129, 0.3)' },
  inRangeText: { fontSize: 11, color: '#10B981', fontWeight: '800', marginLeft: 4, textTransform: 'uppercase' },
  atmCardBody: { marginBottom: 12 },
  atmInfoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  atmAddress: { marginLeft: 10, fontSize: 14, color: '#94A3B8', flex: 1 },
  atmDistance: { marginLeft: 10, fontSize: 14, color: '#6366F1', fontWeight: '700' },
  atmPendingText: { color: '#F59E0B', fontSize: 11, fontWeight: '800', marginTop: 4 },
  atmCardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  statusBadge: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderHeight: 1 },
  statusBadgeText: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  offlineBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(244, 63, 94, 0.15)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(244, 63, 94, 0.3)' },
  offlineBadgeText: { fontSize: 11, color: '#F43F5E', fontWeight: '800', marginLeft: 4, textTransform: 'uppercase' },
  infoBar: { paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#6366F1' },
  infoBarText: { color: '#FFF', fontSize: 12, textAlign: 'center', fontWeight: '700', letterSpacing: 0.3 },
  promptOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  promptContent: { backgroundColor: '#FFF', borderRadius: 24, padding: 24, alignItems: 'center', width: '100%', maxWidth: 340 },
  promptIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#EEF2FF', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  promptTitle: { fontSize: 22, fontWeight: '700', color: '#1F2937', marginBottom: 8 },
  promptSubtitle: { fontSize: 16, color: '#4B5563', textAlign: 'center' },
  promptDistance: { fontSize: 15, color: '#4F46E5', fontWeight: '600', marginTop: 4, marginBottom: 12 },
  promptQuestion: { fontSize: 14, color: '#6B7280', textAlign: 'center', marginBottom: 20 },
  promptButtons: { width: '100%', gap: 12 },
  promptButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 16, borderRadius: 14 },
  promptButtonPrimary: { backgroundColor: '#4F46E5' },
  promptButtonSecondary: { backgroundColor: '#F3F4F6' },
  promptButtonTextPrimary: { color: '#FFF', fontWeight: '600', fontSize: 16, marginLeft: 8 },
  promptButtonTextSecondary: { color: '#4B5563', fontWeight: '600', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.8)', justifyContent: 'flex-end' },
  detailContent: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 32, borderTopRightRadius: 32, padding: 24, width: '100%', maxHeight: '92%', shadowColor: '#000', shadowOffset: { width: 0, height: -20 }, shadowOpacity: 0.4, shadowRadius: 24, elevation: 30 },
  sheetHandle: { width: 40, height: 5, backgroundColor: '#E2E8F0', borderRadius: 3, alignSelf: 'center', marginBottom: 20 },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  detailTitleWrapper: { flex: 1 },
  detailBankName: { fontSize: 28, fontWeight: '900', color: '#0F172A', letterSpacing: -0.5 },
  detailBranchName: { fontSize: 15, color: '#64748B', marginTop: 2, fontWeight: '600' },
  detailStatusSection: { alignItems: 'center', marginBottom: 24, backgroundColor: '#F8FAFC', padding: 20, borderRadius: 24, borderWidth: 1, borderColor: '#E2E8F0' },
  detailStatusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 18, gap: 12, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 2 },
  detailStatusText: { fontSize: 22, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 1 },
  notifyButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EEF2FF', paddingHorizontal: 20, paddingVertical: 14, borderRadius: 16, borderWidth: 1.5, borderColor: '#6366F1' },
  notifyButtonText: { color: '#4F46E5', fontSize: 14, fontWeight: '800', marginLeft: 8 },
  closeButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F1F5F9', justifyContent: 'center', alignItems: 'center' },
  statusBadgeLarge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 14, alignSelf: 'flex-start', marginBottom: 16 },
  statusBadgeLargeText: { color: '#FFF', fontWeight: '600', fontSize: 15, marginLeft: 8 },
  infoSection: { marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  infoText: { color: '#334155', fontSize: 16, marginLeft: 12, flex: 1, fontWeight: '600' },
  offlineWarning: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEE2E2', padding: 14, borderRadius: 14, marginTop: 8 },
  offlineText: { marginLeft: 12, color: '#991B1B', fontWeight: '600', fontSize: 15 },
  directionsButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#6366F1', paddingVertical: 18, borderRadius: 20, marginTop: 12, shadowColor: '#6366F1', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  directionsButtonText: { color: '#FFF', fontWeight: '900', fontSize: 16, marginLeft: 8, textTransform: 'uppercase', letterSpacing: 1 },
  notificationBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: '#475569', position: 'relative' },
  notifBadge: { position: 'absolute', top: 8, right: 8, width: 10, height: 10, borderRadius: 5, backgroundColor: '#F43F5E', borderWidth: 2, borderColor: '#334155' },
  modalOverlayCenter: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  notifContent: { backgroundColor: '#1E293B', borderRadius: 24, width: '100%', maxWidth: 340, padding: 20, borderWidth: 1, borderColor: '#334155' },
  notifHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  notifTitle: { fontSize: 20, fontWeight: '800', color: '#F8FAFC' },
  notifList: { maxHeight: 400 },
  noNotifText: { color: '#94A3B8', textAlign: 'center', paddingVertical: 40, fontSize: 15 },
  notifItem: { flexDirection: 'row', padding: 12, borderRadius: 16, marginBottom: 8, backgroundColor: '#0F172A' },
  notifItemUnread: { borderWidth: 1, borderColor: '#6366F1' },
  notifIndicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#6366F1', marginTop: 6, marginRight: 12 },
  notifInfo: { flex: 1 },
  notifMsgTitle: { color: '#F8FAFC', fontWeight: '700', fontSize: 14, marginBottom: 2 },
  notifMsg: { color: '#94A3B8', fontSize: 13, lineHeight: 18 },
  notifTime: { color: '#475569', fontSize: 11, marginTop: 4, fontWeight: '600' },
  geofenceStatus: { flexDirection: 'row', alignItems: 'center', padding: 18, borderRadius: 18, marginBottom: 20 },
  geofenceTextContainer: { marginLeft: 14, flex: 1 },
  geofenceTitle: { fontSize: 17, fontWeight: '600' },
  geofenceSubtext: { fontSize: 14, marginTop: 4 },
  reportTitle: { fontSize: 18, fontWeight: '900', color: '#0F172A', marginBottom: 20, textAlign: 'center', textTransform: 'uppercase', letterSpacing: 1 },
  reportButtonsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'space-between', marginBottom: 20 },
  reportButton: { width: '47%', height: 100, borderRadius: 24, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 6 },
  reportButtonDisabled: { opacity: 0.4 },
  reportButtonText: { color: '#FFF', fontWeight: '900', fontSize: 13, marginTop: 10, textTransform: 'uppercase' },
  addForm: { marginTop: 8 },
  inputLabel: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 8, marginLeft: 4, textTransform: 'uppercase' },
  formInput: { backgroundColor: '#F8FAFC', borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, color: '#0F172A', marginBottom: 20, fontWeight: '600' },
  locationSummary: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EEF2FF', padding: 12, borderRadius: 12, marginBottom: 20 },
  locationSummaryText: { marginLeft: 10, color: '#4F46E5', fontSize: 13, fontWeight: '700' },
  photoButton: { height: 160, backgroundColor: '#F8FAFC', borderRadius: 24, borderWidth: 2, borderColor: '#E2E8F0', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center', marginBottom: 24, overflow: 'hidden' },
  photoButtonText: { marginTop: 10, fontSize: 15, fontWeight: '800', color: '#6366F1' },
  photoSubtext: { marginTop: 4, fontSize: 12, color: '#94A3B8', fontWeight: '600' },
  photoPreviewContainer: { width: '100%', height: '100%', position: 'relative' },
  photoPreview: { width: '100%', height: '100%' },
  photoSuccessOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(255, 255, 255, 0.95)', paddingVertical: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  photoSuccessText: { color: '#10B981', fontWeight: '800', fontSize: 13 },
  verificationCard: { backgroundColor: '#FFF7ED', padding: 16, borderRadius: 20, borderWidth: 1, borderColor: '#FED7AA', marginBottom: 20 },
  verificationTitle: { fontSize: 15, fontWeight: '900', color: '#9A3412', marginBottom: 4 },
  verificationSubtitle: { fontSize: 13, color: '#C2410C', marginBottom: 16 },
  voteButtons: { flexDirection: 'row', gap: 10 },
  voteBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 12, gap: 8 },
  voteYes: { backgroundColor: '#10B981' },
  voteNo: { backgroundColor: '#F43F5E' },
  voteText: { color: '#FFF', fontWeight: '800', fontSize: 12 },
});
