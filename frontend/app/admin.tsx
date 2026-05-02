import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://neurocash.vercel.app";
const { width } = Dimensions.get('window');

interface AdminStats {
  total_users: number;
  total_atms: number;
  status_distribution: Record<string, number>;
  recent_reports_24h: number;
  top_contributors: Array<{ name: string; points: number; level: string }>;
  uptime_percentage: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      const token = await AsyncStorage.getItem('googleToken');
      const response = await axios.get(`${BACKEND_URL}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setStats(response.data);
      setError(null);
    } catch (err: any) {
      console.error('Error fetching admin stats:', err);
      setError(err.response?.data?.detail || "Failed to load admin data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchStats();
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366F1" />
        <Text style={styles.loadingText}>Loading Analytics...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed" size={64} color="#EF4444" />
        <Text style={styles.errorTitle}>Access Denied</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={28} color="#F8FAFC" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>System Intelligence</Text>
        <TouchableOpacity onPress={onRefresh}>
          <Ionicons name="refresh" size={24} color="#6366F1" />
        </TouchableOpacity>
      </View>

      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6366F1" />}
      >
        {/* Main Stats Row */}
        <View style={styles.statsGrid}>
          <View style={[styles.statCard, { backgroundColor: '#312E81' }]}>
            <Ionicons name="people" size={24} color="#A5B4FC" />
            <Text style={styles.statValue}>{stats?.total_users}</Text>
            <Text style={styles.statLabel}>Total Users</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: '#064E3B' }]}>
            <Ionicons name="pulse" size={24} color="#6EE7B7" />
            <Text style={styles.statValue}>{stats?.uptime_percentage.toFixed(1)}%</Text>
            <Text style={styles.statLabel}>Avg Liquidity</Text>
          </View>
        </View>

        {/* Secondary Stats Row */}
        <View style={styles.statsGrid}>
          <View style={[styles.statCard, { backgroundColor: '#1E293B' }]}>
            <Ionicons name="location" size={24} color="#94A3B8" />
            <Text style={styles.statValue}>{stats?.total_atms}</Text>
            <Text style={styles.statLabel}>Mapped ATMs</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: '#451A03' }]}>
            <Ionicons name="flash" size={24} color="#FDE047" />
            <Text style={styles.statValue}>{stats?.recent_reports_24h}</Text>
            <Text style={styles.statLabel}>Reports (24h)</Text>
          </View>
        </View>

        {/* Status Distribution */}
        <Text style={styles.sectionTitle}>Network Status</Text>
        <View style={styles.chartPlaceholder}>
          {Object.entries(stats?.status_distribution || {}).map(([status, count]) => (
            <View key={status} style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: getStatusColor(status) }]} />
              <Text style={styles.statusName}>{status.charAt(0).toUpperCase() + status.slice(1)}</Text>
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { 
                  width: `${(count / (stats?.total_atms || 1)) * 100}%`,
                  backgroundColor: getStatusColor(status)
                }]} />
              </View>
              <Text style={styles.statusCount}>{count}</Text>
            </View>
          ))}
        </View>

        {/* Top Contributors */}
        <Text style={styles.sectionTitle}>Top Contributors</Text>
        {stats?.top_contributors.map((user, idx) => (
          <View key={idx} style={styles.userCard}>
            <View style={styles.userRank}>
              <Text style={styles.rankText}>#{idx + 1}</Text>
            </View>
            <View style={styles.userInfo}>
              <Text style={styles.userName}>{user.name}</Text>
              <Text style={styles.userLevel}>{user.level} Reporter</Text>
            </View>
            <View style={styles.userPoints}>
              <Text style={styles.pointsValue}>{user.points}</Text>
              <Text style={styles.pointsLabel}>pts</Text>
            </View>
          </View>
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const getStatusColor = (status: string) => {
  switch (status) {
    case 'green': return '#10B981';
    case 'yellow': return '#F59E0B';
    case 'red': return '#EF4444';
    case 'grey': return '#6B7280';
    default: return '#6B7280';
  }
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#F8FAFC', letterSpacing: -0.5 },
  backIcon: { width: 40, height: 40, justifyContent: 'center' },
  scrollContent: { padding: 20 },
  center: { flex: 1, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { color: '#94A3B8', marginTop: 16, fontSize: 15, fontWeight: '600' },
  errorTitle: { color: '#F8FAFC', fontSize: 24, fontWeight: '800', marginTop: 24 },
  errorText: { color: '#94A3B8', textAlign: 'center', marginTop: 8, lineHeight: 22 },
  backBtn: { backgroundColor: '#6366F1', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12, marginTop: 32 },
  backBtnText: { color: '#FFF', fontWeight: '700' },
  statsGrid: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  statCard: { flex: 1, padding: 20, borderRadius: 20, justifyContent: 'center' },
  statValue: { fontSize: 28, fontWeight: '900', color: '#FFF', marginTop: 12 },
  statLabel: { fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: '700', marginTop: 2, textTransform: 'uppercase' },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: '#F8FAFC', marginTop: 24, marginBottom: 16, letterSpacing: -0.3 },
  chartPlaceholder: { backgroundColor: '#1E293B', borderRadius: 24, padding: 20, borderWidth: 1, borderColor: '#334155' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  statusName: { color: '#94A3B8', fontSize: 13, width: 60, fontWeight: '700' },
  progressBarBg: { flex: 1, height: 8, backgroundColor: '#0F172A', borderRadius: 4, marginHorizontal: 12 },
  progressBarFill: { height: '100%', borderRadius: 4 },
  statusCount: { color: '#F8FAFC', fontSize: 14, fontWeight: '800', width: 30, textAlign: 'right' },
  userCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', padding: 16, borderRadius: 18, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  userRank: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  rankText: { color: '#6366F1', fontWeight: '900', fontSize: 14 },
  userInfo: { flex: 1 },
  userName: { color: '#F8FAFC', fontWeight: '700', fontSize: 15 },
  userLevel: { color: '#94A3B8', fontSize: 12, marginTop: 2 },
  userPoints: { alignItems: 'flex-end' },
  pointsValue: { color: '#6366F1', fontWeight: '900', fontSize: 18 },
  pointsLabel: { color: '#475569', fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
});
