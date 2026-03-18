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
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;
const { width, height } = Dimensions.get('window');
const isWeb = Platform.OS === 'web';

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

// Status colors
const STATUS_COLORS: Record<string, string> = {
  green: '#22C55E',
  yellow: '#EAB308',
  red: '#EF4444',
  grey: '#6B7280',
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
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [atms, setAtms] = useState<ATM[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedATM, setSelectedATM] = useState<ATM | null>(null);
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [isWithinGeofence, setIsWithinGeofence] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [userId] = useState(`user_${Date.now()}`);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [nearbyATMPrompt, setNearbyATMPrompt] = useState<ATM | null>(null);
  const [promptedATMs, setPromptedATMs] = useState<Set<string>>(new Set());
  const pollingInterval = useRef<NodeJS.Timeout | null>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);

  // Default location: Champadali More, Barasat
  const defaultLocation = {
    latitude: 22.7246,
    longitude: 88.4844,
  };

  // Start live location tracking
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!isWeb) {
            Alert.alert('Permission Denied', 'Location permission is required. Using default location.');
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
    })();

    return () => {
      if (locationSubscription.current) {
        locationSubscription.current.remove();
      }
    };
  }, []);

  // Fetch nearby ATMs
  const fetchNearbyATMs = useCallback(async () => {
    if (!userLocation) return;

    try {
      const response = await axios.get(`${BACKEND_URL}/api/atms/nearby`, {
        params: {
          lat: userLocation.latitude,
          lng: userLocation.longitude,
          radius: 1000,
        },
      });
      setAtms(response.data);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error fetching ATMs:', error);
      try {
        const fallbackResponse = await axios.get(`${BACKEND_URL}/api/atms/all`);
        setAtms(fallbackResponse.data);
        setLastRefresh(new Date());
      } catch (fallbackError) {
        console.error('Fallback fetch failed:', fallbackError);
      }
    } finally {
      setLoading(false);
    }
  }, [userLocation]);

  // Initial fetch and 30-second polling
  useEffect(() => {
    if (userLocation) {
      fetchNearbyATMs();

      pollingInterval.current = setInterval(() => {
        fetchNearbyATMs();
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

      if (distance <= 50 && !promptedATMs.has(atm.id)) {
        setNearbyATMPrompt(atm);
        setPromptedATMs((prev) => new Set(prev).add(atm.id));
        break;
      }
    }
  }, [userLocation, atms, promptedATMs]);

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
      await axios.post(`${BACKEND_URL}/api/atms/${selectedATM.id}/report`, {
        atm_id: selectedATM.id,
        user_id: userId,
        status,
        user_lat: userLocation.latitude,
        user_lng: userLocation.longitude,
      });

      if (!isWeb) {
        Alert.alert('Thank You!', 'Your report helps other users find cash!');
      }
      setReportModalVisible(false);
      setNearbyATMPrompt(null);
      fetchNearbyATMs();
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail || 'Failed to submit report.';
      if (!isWeb) {
        Alert.alert('Error', errorMsg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openInGoogleMaps = (atm: ATM) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${atm.latitude},${atm.longitude}`;
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

    const distanceToATM = userLocation
      ? haversineDistance(userLocation.latitude, userLocation.longitude, selectedATM.latitude, selectedATM.longitude)
      : 0;

    return (
      <Modal visible={reportModalVisible} animationType="slide" transparent onRequestClose={() => setReportModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderLeft}>
                <View style={[styles.modalStatusIndicator, { backgroundColor: getStatusColor(selectedATM.current_status) }]}>
                  <Ionicons name="cash" size={24} color="#FFF" />
                </View>
                <View style={styles.modalHeaderInfo}>
                  <Text style={styles.modalTitle}>{selectedATM.bank_name}</Text>
                  <Text style={styles.modalSubtitle}>{selectedATM.branch_name}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setReportModalVisible(false)} style={styles.closeButton}>
                <Ionicons name="close" size={24} color="#374151" />
              </TouchableOpacity>
            </View>

            <View style={[styles.statusBadgeLarge, { backgroundColor: getStatusColor(selectedATM.current_status) }]}>
              <Ionicons name={STATUS_ICONS[selectedATM.current_status] as any} size={20} color="#FFF" />
              <Text style={styles.statusBadgeLargeText}>{STATUS_LABELS[selectedATM.current_status]}</Text>
            </View>

            <View style={styles.infoSection}>
              <View style={styles.infoRow}>
                <Ionicons name="location-outline" size={20} color="#6B7280" />
                <Text style={styles.infoText}>{selectedATM.address}</Text>
              </View>
              <View style={styles.infoRow}>
                <Ionicons name="navigate-outline" size={20} color="#6B7280" />
                <Text style={styles.infoText}>{distanceToATM.toFixed(0)}m away</Text>
              </View>
              {!selectedATM.bank_online && (
                <View style={styles.offlineWarning}>
                  <Ionicons name="warning" size={20} color="#EF4444" />
                  <Text style={styles.offlineText}>Bank server offline</Text>
                </View>
              )}
            </View>

            {/* Get Directions Button */}
            <TouchableOpacity style={styles.directionsButton} onPress={() => openInGoogleMaps(selectedATM)}>
              <Ionicons name="navigate" size={20} color="#FFF" />
              <Text style={styles.directionsButtonText}>Get Directions</Text>
            </TouchableOpacity>

            <View style={[styles.geofenceStatus, { backgroundColor: isWithinGeofence ? '#DCFCE7' : '#FEE2E2' }]}>
              <Ionicons
                name={isWithinGeofence ? 'checkmark-circle' : 'close-circle'}
                size={28}
                color={isWithinGeofence ? '#22C55E' : '#EF4444'}
              />
              <View style={styles.geofenceTextContainer}>
                <Text style={[styles.geofenceTitle, { color: isWithinGeofence ? '#166534' : '#991B1B' }]}>
                  {isWithinGeofence ? 'Within Geofence (50m)' : 'Outside Geofence'}
                </Text>
                <Text style={[styles.geofenceSubtext, { color: isWithinGeofence ? '#166534' : '#991B1B' }]}>
                  {isWithinGeofence ? 'You can report ATM status' : `Move ${Math.max(0, distanceToATM - 50).toFixed(0)}m closer to report`}
                </Text>
              </View>
            </View>

            <Text style={styles.reportTitle}>Report ATM Status</Text>
            <View style={styles.reportButtonsGrid}>
              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#22C55E' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('cash')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="checkmark-circle" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>Cash Available</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#EAB308' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('low_cash')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="alert-circle" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>Low Cash</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#F97316' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('long_queue')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="people" size={32} color="#FFF" />
                <Text style={styles.reportButtonText}>Long Queue</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.reportButton, { backgroundColor: '#EF4444' }, !isWithinGeofence && styles.reportButtonDisabled]}
                onPress={() => reportStatus('no_cash')}
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

  // Render list view
  const renderListView = () => {
    return (
      <ScrollView style={styles.listContainer} showsVerticalScrollIndicator={false}>
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
  if (loading || !userLocation) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <View style={styles.loadingContent}>
          <View style={styles.loadingIconContainer}>
            <Ionicons name="cash" size={48} color="#4F46E5" />
          </View>
          <Text style={styles.loadingTitle}>NeuroCash</Text>
          <Text style={styles.loadingSubtitle}>ATM Liquidity Mapper</Text>
          <ActivityIndicator size="large" color="#4F46E5" style={{ marginTop: 24 }} />
          <Text style={styles.loadingText}>Getting your location...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.logoContainer}>
            <Ionicons name="cash" size={24} color="#4F46E5" />
          </View>
          <View>
            <Text style={styles.headerTitle}>NeuroCash</Text>
            <Text style={styles.headerSubtitle}>{atms.length} ATMs nearby</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.refreshButton} onPress={fetchNearbyATMs}>
          <Ionicons name="refresh" size={22} color="#4F46E5" />
        </TouchableOpacity>
      </View>

      {/* Location Bar */}
      <View style={styles.locationBar}>
        <Ionicons name="location" size={16} color="#4F46E5" />
        <Text style={styles.locationText}>
          {userLocation.latitude.toFixed(4)}, {userLocation.longitude.toFixed(4)}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F4F6' },
  loadingContainer: { flex: 1, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center' },
  loadingContent: { alignItems: 'center' },
  loadingIconContainer: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#EEF2FF', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  loadingTitle: { fontSize: 28, fontWeight: '700', color: '#1F2937' },
  loadingSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  loadingText: { marginTop: 16, fontSize: 14, color: '#6B7280' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  logoContainer: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#EEF2FF', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#1F2937' },
  headerSubtitle: { fontSize: 12, color: '#6B7280' },
  refreshButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#EEF2FF', justifyContent: 'center', alignItems: 'center' },
  locationBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, backgroundColor: '#EEF2FF' },
  locationText: { fontSize: 12, color: '#4F46E5', marginLeft: 4, fontWeight: '500' },
  locationDivider: { width: 1, height: 14, backgroundColor: '#A5B4FC', marginHorizontal: 12 },
  liveDotSmall: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E' },
  liveTextSmall: { fontSize: 12, color: '#22C55E', fontWeight: '600', marginLeft: 4 },
  legend: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 10, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 12, height: 12, borderRadius: 6, marginRight: 6 },
  legendText: { fontSize: 12, color: '#4B5563', fontWeight: '500' },
  listContainer: { flex: 1, padding: 16 },
  emptyState: { alignItems: 'center', paddingVertical: 48 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#374151', marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  atmCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  atmCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  statusIndicator: { width: 48, height: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  atmCardInfo: { flex: 1 },
  atmBankName: { fontSize: 17, fontWeight: '600', color: '#1F2937' },
  atmBranchName: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  inRangeBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DCFCE7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 },
  inRangeText: { fontSize: 12, color: '#22C55E', fontWeight: '600', marginLeft: 4 },
  atmCardBody: { marginBottom: 12 },
  atmInfoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  atmAddress: { marginLeft: 8, fontSize: 14, color: '#4B5563', flex: 1 },
  atmDistance: { marginLeft: 8, fontSize: 14, color: '#4F46E5', fontWeight: '600' },
  atmCardFooter: { flexDirection: 'row', alignItems: 'center' },
  statusBadge: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  statusBadgeText: { fontSize: 13, fontWeight: '600' },
  offlineBadge: { flexDirection: 'row', alignItems: 'center', marginLeft: 10, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#FEE2E2', borderRadius: 10 },
  offlineBadgeText: { fontSize: 12, color: '#EF4444', fontWeight: '600', marginLeft: 4 },
  infoBar: { paddingVertical: 12, paddingHorizontal: 16, backgroundColor: '#4F46E5' },
  infoBarText: { color: '#FFF', fontSize: 13, textAlign: 'center', fontWeight: '500' },
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
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: height * 0.85 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  modalHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  modalStatusIndicator: { width: 52, height: 52, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  modalHeaderInfo: { flex: 1 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#1F2937' },
  modalSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 2 },
  closeButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center' },
  statusBadgeLarge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 14, alignSelf: 'flex-start', marginBottom: 16 },
  statusBadgeLargeText: { color: '#FFF', fontWeight: '600', fontSize: 15, marginLeft: 8 },
  infoSection: { marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  infoText: { marginLeft: 12, fontSize: 15, color: '#4B5563', flex: 1 },
  offlineWarning: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEE2E2', padding: 14, borderRadius: 14, marginTop: 8 },
  offlineText: { marginLeft: 12, color: '#991B1B', fontWeight: '600', fontSize: 15 },
  directionsButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#4F46E5', paddingVertical: 14, borderRadius: 14, marginBottom: 16 },
  directionsButtonText: { color: '#FFF', fontWeight: '600', fontSize: 15, marginLeft: 8 },
  geofenceStatus: { flexDirection: 'row', alignItems: 'center', padding: 18, borderRadius: 18, marginBottom: 20 },
  geofenceTextContainer: { marginLeft: 14, flex: 1 },
  geofenceTitle: { fontSize: 17, fontWeight: '600' },
  geofenceSubtext: { fontSize: 14, marginTop: 4 },
  reportTitle: { fontSize: 17, fontWeight: '600', color: '#1F2937', marginBottom: 16 },
  reportButtonsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  reportButton: { width: '48%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingVertical: 24, borderRadius: 18, marginBottom: 12 },
  reportButtonDisabled: { opacity: 0.4 },
  reportButtonText: { color: '#FFF', fontWeight: '600', fontSize: 14, marginTop: 10, textAlign: 'center' },
});
