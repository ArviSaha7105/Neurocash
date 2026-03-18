import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  FlatList,
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import axios from 'axios';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;
const { width, height } = Dimensions.get('window');

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
  green: '#22C55E',   // Cash available
  yellow: '#EAB308',  // Low cash/Long queue
  red: '#EF4444',     // No cash or Bank offline
  grey: '#6B7280',    // Unknown status
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
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export default function NeuroCashApp() {
  // State
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [atms, setAtms] = useState<ATM[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedATM, setSelectedATM] = useState<ATM | null>(null);
  const [reportModalVisible, setReportModalVisible] = useState(false);
  const [isWithinGeofence, setIsWithinGeofence] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [userId] = useState(`user_${Date.now()}`);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const pollingInterval = useRef<NodeJS.Timeout | null>(null);

  // Default location: Champadali More, Barasat (for testing)
  const defaultLocation = {
    latitude: 22.7246,
    longitude: 88.4844,
  };

  // Get user location
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          // Use default location if permission denied
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
      } catch (error) {
        console.error('Location error:', error);
        setUserLocation(defaultLocation);
      }
    })();
  }, []);

  // Fetch nearby ATMs
  const fetchNearbyATMs = useCallback(async () => {
    if (!userLocation) return;

    try {
      const response = await axios.get(`${BACKEND_URL}/api/atms/nearby`, {
        params: {
          lat: userLocation.latitude,
          lng: userLocation.longitude,
          radius: 1000, // 1km radius
        },
      });
      setAtms(response.data);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error fetching ATMs:', error);
      // Try to fetch all ATMs as fallback
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

      // Set up 30-second polling interval
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

  // Handle ATM card press
  const handleATMPress = (atm: ATM) => {
    setSelectedATM(atm);
    setReportModalVisible(true);
  };

  // Report ATM status
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

      Alert.alert('Success', 'Your report has been submitted!');
      setReportModalVisible(false);
      fetchNearbyATMs(); // Refresh data
    } catch (error: any) {
      const errorMsg =
        error.response?.data?.detail ||
        'Failed to submit report. You must be within 50m of the ATM.';
      Alert.alert('Error', errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

  // Get marker color based on status
  const getStatusColor = (status: string): string => {
    return STATUS_COLORS[status] || STATUS_COLORS.grey;
  };

  // Render ATM Card
  const renderATMCard = ({ item: atm }: { item: ATM }) => {
    const distanceToATM = userLocation
      ? haversineDistance(
          userLocation.latitude,
          userLocation.longitude,
          atm.latitude,
          atm.longitude
        )
      : atm.distance_meters || 0;

    const canReport = distanceToATM <= 50;

    return (
      <TouchableOpacity
        style={styles.atmCard}
        onPress={() => handleATMPress(atm)}
        activeOpacity={0.7}
      >
        <View style={styles.atmCardHeader}>
          <View
            style={[
              styles.statusIndicator,
              { backgroundColor: getStatusColor(atm.current_status) },
            ]}
          >
            <Ionicons
              name={STATUS_ICONS[atm.current_status] as any}
              size={20}
              color="#FFF"
            />
          </View>
          <View style={styles.atmCardInfo}>
            <Text style={styles.atmBankName}>{atm.bank_name}</Text>
            <Text style={styles.atmBranchName}>{atm.branch_name}</Text>
          </View>
          {canReport && (
            <View style={styles.canReportBadge}>
              <Ionicons name="location" size={14} color="#22C55E" />
              <Text style={styles.canReportText}>In Range</Text>
            </View>
          )}
        </View>

        <View style={styles.atmCardBody}>
          <View style={styles.atmInfoRow}>
            <Ionicons name="location-outline" size={16} color="#6B7280" />
            <Text style={styles.atmAddress} numberOfLines={1}>
              {atm.address}
            </Text>
          </View>
          <View style={styles.atmInfoRow}>
            <Ionicons name="navigate-outline" size={16} color="#6B7280" />
            <Text style={styles.atmDistance}>
              {distanceToATM.toFixed(0)}m away
            </Text>
          </View>
        </View>

        <View style={styles.atmCardFooter}>
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: getStatusColor(atm.current_status) + '20' },
            ]}
          >
            <Text
              style={[
                styles.statusBadgeText,
                { color: getStatusColor(atm.current_status) },
              ]}
            >
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
  };

  // Render ATM detail modal
  const renderATMModal = () => {
    if (!selectedATM) return null;

    const distanceToATM = userLocation
      ? haversineDistance(
          userLocation.latitude,
          userLocation.longitude,
          selectedATM.latitude,
          selectedATM.longitude
        )
      : 0;

    return (
      <Modal
        visible={reportModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setReportModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderLeft}>
                <View
                  style={[
                    styles.modalStatusIndicator,
                    { backgroundColor: getStatusColor(selectedATM.current_status) },
                  ]}
                >
                  <Ionicons name="cash" size={24} color="#FFF" />
                </View>
                <View>
                  <Text style={styles.modalTitle}>{selectedATM.bank_name}</Text>
                  <Text style={styles.modalSubtitle}>
                    {selectedATM.branch_name}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setReportModalVisible(false)}
                style={styles.closeButton}
              >
                <Ionicons name="close" size={24} color="#374151" />
              </TouchableOpacity>
            </View>

            {/* Status Badge */}
            <View
              style={[
                styles.modalStatusBadge,
                { backgroundColor: getStatusColor(selectedATM.current_status) },
              ]}
            >
              <Ionicons
                name={STATUS_ICONS[selectedATM.current_status] as any}
                size={20}
                color="#FFF"
              />
              <Text style={styles.modalStatusBadgeText}>
                {STATUS_LABELS[selectedATM.current_status]}
              </Text>
            </View>

            {/* Info */}
            <View style={styles.infoSection}>
              <View style={styles.infoRow}>
                <Ionicons name="location-outline" size={20} color="#6B7280" />
                <Text style={styles.infoText}>{selectedATM.address}</Text>
              </View>
              <View style={styles.infoRow}>
                <Ionicons name="navigate-outline" size={20} color="#6B7280" />
                <Text style={styles.infoText}>
                  {distanceToATM.toFixed(0)}m away
                </Text>
              </View>
              {!selectedATM.bank_online && (
                <View style={styles.offlineWarning}>
                  <Ionicons name="warning" size={20} color="#EF4444" />
                  <Text style={styles.offlineText}>Bank server offline</Text>
                </View>
              )}
            </View>

            {/* Geofence Status (TC_02) */}
            <View
              style={[
                styles.geofenceStatus,
                {
                  backgroundColor: isWithinGeofence ? '#DCFCE7' : '#FEE2E2',
                },
              ]}
            >
              <Ionicons
                name={isWithinGeofence ? 'checkmark-circle' : 'close-circle'}
                size={24}
                color={isWithinGeofence ? '#22C55E' : '#EF4444'}
              />
              <View style={styles.geofenceTextContainer}>
                <Text
                  style={[
                    styles.geofenceTitle,
                    { color: isWithinGeofence ? '#166534' : '#991B1B' },
                  ]}
                >
                  {isWithinGeofence ? 'Within Geofence' : 'Outside Geofence'}
                </Text>
                <Text
                  style={[
                    styles.geofenceSubtext,
                    { color: isWithinGeofence ? '#166534' : '#991B1B' },
                  ]}
                >
                  {isWithinGeofence
                    ? 'You can report ATM status'
                    : `Move ${(distanceToATM - 50).toFixed(0)}m closer to report`}
                </Text>
              </View>
            </View>

            {/* Report Buttons - Only enabled within 50m geofence (TC_02) */}
            <Text style={styles.reportTitle}>Report ATM Status</Text>
            <View style={styles.reportButtonsGrid}>
              <TouchableOpacity
                style={[
                  styles.reportButton,
                  { backgroundColor: '#22C55E' },
                  !isWithinGeofence && styles.reportButtonDisabled,
                ]}
                onPress={() => reportStatus('cash')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="checkmark-circle" size={28} color="#FFF" />
                <Text style={styles.reportButtonText}>Cash Available</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.reportButton,
                  { backgroundColor: '#EAB308' },
                  !isWithinGeofence && styles.reportButtonDisabled,
                ]}
                onPress={() => reportStatus('low_cash')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="alert-circle" size={28} color="#FFF" />
                <Text style={styles.reportButtonText}>Low Cash</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.reportButton,
                  { backgroundColor: '#F97316' },
                  !isWithinGeofence && styles.reportButtonDisabled,
                ]}
                onPress={() => reportStatus('long_queue')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="people" size={28} color="#FFF" />
                <Text style={styles.reportButtonText}>Long Queue</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.reportButton,
                  { backgroundColor: '#EF4444' },
                  !isWithinGeofence && styles.reportButtonDisabled,
                ]}
                onPress={() => reportStatus('no_cash')}
                disabled={!isWithinGeofence || submitting}
              >
                <Ionicons name="close-circle" size={28} color="#FFF" />
                <Text style={styles.reportButtonText}>No Cash</Text>
              </TouchableOpacity>
            </View>

            {submitting && (
              <ActivityIndicator
                size="small"
                color="#4F46E5"
                style={{ marginTop: 16 }}
              />
            )}
          </View>
        </View>
      </Modal>
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
          <ActivityIndicator
            size="large"
            color="#4F46E5"
            style={{ marginTop: 24 }}
          />
          <Text style={styles.loadingText}>Finding nearby ATMs...</Text>
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
            <Ionicons name="cash" size={28} color="#4F46E5" />
          </View>
          <View>
            <Text style={styles.headerTitle}>NeuroCash</Text>
            <Text style={styles.headerSubtitle}>ATM Liquidity Mapper</Text>
          </View>
        </View>
        <TouchableOpacity onPress={fetchNearbyATMs} style={styles.refreshButton}>
          <Ionicons name="refresh" size={24} color="#4F46E5" />
        </TouchableOpacity>
      </View>

      {/* Location Info */}
      <View style={styles.locationBar}>
        <Ionicons name="location" size={16} color="#4F46E5" />
        <Text style={styles.locationText}>
          {userLocation.latitude.toFixed(4)}, {userLocation.longitude.toFixed(4)}
        </Text>
        <Text style={styles.locationDivider}>|</Text>
        <Text style={styles.locationText}>1km radius</Text>
      </View>

      {/* Status Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#22C55E' }]} />
          <Text style={styles.legendText}>Cash</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#EAB308' }]} />
          <Text style={styles.legendText}>Low/Queue</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#EF4444' }]} />
          <Text style={styles.legendText}>No Cash</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#6B7280' }]} />
          <Text style={styles.legendText}>Unknown</Text>
        </View>
      </View>

      {/* ATM List */}
      <FlatList
        data={atms}
        renderItem={renderATMCard}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="location-outline" size={64} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>No ATMs Found</Text>
            <Text style={styles.emptySubtitle}>
              No ATMs within 1km of your location
            </Text>
          </View>
        }
      />

      {/* Info Bar */}
      <View style={styles.infoBar}>
        <Text style={styles.infoBarText}>
          {atms.length} ATMs found • Updated: {lastRefresh.toLocaleTimeString()}
        </Text>
      </View>

      {/* ATM Detail Modal */}
      {renderATMModal()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContent: {
    alignItems: 'center',
  },
  loadingIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  loadingTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1F2937',
  },
  loadingSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 4,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
    color: '#6B7280',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1F2937',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#6B7280',
  },
  refreshButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  locationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    backgroundColor: '#EEF2FF',
  },
  locationText: {
    fontSize: 12,
    color: '#4F46E5',
    marginLeft: 4,
  },
  locationDivider: {
    marginHorizontal: 8,
    color: '#A5B4FC',
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 10,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 6,
  },
  legendText: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '500',
  },
  listContainer: {
    padding: 16,
  },
  atmCard: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  atmCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusIndicator: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  atmCardInfo: {
    flex: 1,
  },
  atmBankName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
  },
  atmBranchName: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  canReportBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  canReportText: {
    fontSize: 11,
    color: '#22C55E',
    fontWeight: '600',
    marginLeft: 4,
  },
  atmCardBody: {
    marginBottom: 12,
  },
  atmInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  atmAddress: {
    marginLeft: 8,
    fontSize: 13,
    color: '#4B5563',
    flex: 1,
  },
  atmDistance: {
    marginLeft: 8,
    fontSize: 13,
    color: '#4B5563',
    fontWeight: '500',
  },
  atmCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  offlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
  },
  offlineBadgeText: {
    fontSize: 11,
    color: '#EF4444',
    fontWeight: '600',
    marginLeft: 4,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 4,
  },
  infoBar: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#4F46E5',
  },
  infoBarText: {
    color: '#FFF',
    fontSize: 12,
    textAlign: 'center',
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    maxHeight: height * 0.85,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  modalHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  modalStatusIndicator: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 2,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  modalStatusBadgeText: {
    color: '#FFF',
    fontWeight: '600',
    fontSize: 14,
    marginLeft: 8,
  },
  infoSection: {
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  infoText: {
    marginLeft: 10,
    fontSize: 14,
    color: '#4B5563',
    flex: 1,
  },
  offlineWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEE2E2',
    padding: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  offlineText: {
    marginLeft: 10,
    color: '#991B1B',
    fontWeight: '600',
    fontSize: 14,
  },
  geofenceStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 20,
  },
  geofenceTextContainer: {
    marginLeft: 12,
    flex: 1,
  },
  geofenceTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  geofenceSubtext: {
    fontSize: 13,
    marginTop: 2,
  },
  reportTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 16,
  },
  reportButtonsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  reportButton: {
    width: '48%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    borderRadius: 16,
    marginBottom: 12,
  },
  reportButtonDisabled: {
    opacity: 0.4,
  },
  reportButtonText: {
    color: '#FFF',
    fontWeight: '600',
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
});
