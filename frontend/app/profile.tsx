import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://neurocash.vercel.app";

const STATUS_ICONS: Record<string, any> = {
  cash: 'cash',
  low_cash: 'alert-circle',
  long_queue: 'people',
  no_cash: 'close-circle',
};

const STATUS_COLORS: Record<string, string> = {
  cash: '#22C55E',
  low_cash: '#EAB308',
  long_queue: '#F97316',
  no_cash: '#EF4444',
};

const STATUS_LABELS: Record<string, string> = {
  cash: 'Cash Available',
  low_cash: 'Low Cash',
  long_queue: 'Long Queue',
  no_cash: 'No Cash',
};

interface Report {
  id: string;
  atm_id: string;
  atm_name: string;
  atm_vicinity: string;
  status: string;
  timestamp: string;
}

interface UserProfile {
  user_id: string;
  karma_score: number;
  report_count: number;
  karma_level: string;
}

export default function ProfileScreen() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [history, setHistory] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProfileData = async () => {
      try {
        const token = await AsyncStorage.getItem('googleToken');
        if (token) {
          const response = await axios.get(`${BACKEND_URL}/api/user/profile`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          setProfile({
            user_id: response.data.user_id || 'user',
            karma_score: response.data.karma_score || 1.0,
            report_count: response.data.report_count || 0,
            karma_level: response.data.karma_level || 'Bronze'
          });
          
          try {
             const userId = response.data.user_id || 'user';
             const historyRes = await axios.get(`${BACKEND_URL}/api/user/history?user_id=${userId}`, {
                headers: { Authorization: `Bearer ${token}` }
             });
             setHistory(historyRes.data.reports || []);
          } catch (e) {
             console.log("Could not load history", e);
             setHistory([]);
          }
        } else {
          // MVP fallback
          setProfile({
            user_id: 'guest_user_123',
            karma_score: 1.0,
            report_count: 0,
            karma_level: 'Bronze'
          });
          setHistory([]);
        }
      } catch (error) {
        console.error('Error fetching profile:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchProfileData();
  }, []);

  const handleLogout = async () => {
    await AsyncStorage.removeItem('googleToken');
    router.replace('/');
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4F46E5" />
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <Text style={styles.errorText}>Could not load profile.</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // Calculate Progress
  const karma = profile.karma_score;
  let progress = 0;
  let nextRank = '';
  let maxScoreForRank = 1;

  if (karma < 2.0) {
    progress = (karma - 1.0) / (2.0 - 1.0);
    maxScoreForRank = 2.0;
    nextRank = 'Silver';
  } else if (karma < 5.0) {
    progress = (karma - 2.0) / (5.0 - 2.0);
    maxScoreForRank = 5.0;
    nextRank = 'Gold';
  } else {
    progress = 1;
    maxScoreForRank = 5.0;
    nextRank = 'Max Rank';
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButtonHeader}>
          <Ionicons name="arrow-back" size={24} color="#1F2937" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Profile</Text>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutButtonHeader}>
          <Ionicons name="log-out-outline" size={24} color="#EF4444" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* Scoreboard Section */}
        <View style={styles.scoreboardCard}>
          <View style={styles.scoreHeader}>
            <View style={[styles.badgeIcon, 
              profile.karma_level === 'Gold' ? styles.bgGold : 
              profile.karma_level === 'Silver' ? styles.bgSilver : 
              styles.bgBronze
            ]}>
              <Ionicons name="trophy" size={32} color="#FFF" />
            </View>
            <View style={styles.scoreInfo}>
              <Text style={styles.scoreLevel}>{profile.karma_level} Rank</Text>
              <Text style={styles.scorePoints}>{karma.toFixed(1)} Karma Score</Text>
            </View>
          </View>

          <View style={styles.progressContainer}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>Progress to {nextRank}</Text>
              <Text style={styles.progressValue}>{Math.round(progress * 100)}%</Text>
            </View>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${progress * 100}%` },
                profile.karma_level === 'Gold' ? styles.bgGold : 
                profile.karma_level === 'Silver' ? styles.bgSilver : 
                styles.bgBronze
              ]} />
            </View>
          </View>

          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{profile.report_count}</Text>
              <Text style={styles.statLabel}>Total Reports</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{history.length}</Text>
              <Text style={styles.statLabel}>Recent Visits</Text>
            </View>
          </View>
        </View>

        {/* History Section */}
        <Text style={styles.sectionTitle}>Recent Reports & Visits</Text>
        
        {history.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={48} color="#D1D5DB" />
            <Text style={styles.emptyText}>No recent ATM reports found.</Text>
          </View>
        ) : (
          history.map(report => (
            <View key={report.id} style={styles.historyCard}>
              <View style={[styles.historyIcon, { backgroundColor: STATUS_COLORS[report.status] + '20' }]}>
                <Ionicons name={STATUS_ICONS[report.status]} size={24} color={STATUS_COLORS[report.status]} />
              </View>
              <View style={styles.historyInfo}>
                <Text style={styles.historyBank}>{report.atm_name}</Text>
                <Text style={styles.historyVicinity}>{report.atm_vicinity}</Text>
                <Text style={styles.historyDate}>{new Date(report.timestamp).toLocaleString()}</Text>
              </View>
              <View style={[styles.historyStatusBadge, { backgroundColor: STATUS_COLORS[report.status] }]}>
                <Text style={styles.historyStatusText}>{STATUS_LABELS[report.status]}</Text>
              </View>
            </View>
          ))
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 16, color: '#6B7280', marginBottom: 16 },
  backButton: { backgroundColor: '#4F46E5', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  backButtonText: { color: '#FFF', fontWeight: '600' },
  container: { flex: 1, backgroundColor: '#F3F4F6' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backButtonHeader: { padding: 4 },
  logoutButtonHeader: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1F2937' },
  scrollContent: { padding: 16 },
  scoreboardCard: { backgroundColor: '#FFF', borderRadius: 20, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 12, elevation: 3, marginBottom: 24 },
  scoreHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  badgeIcon: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  bgGold: { backgroundColor: '#F59E0B' },
  bgSilver: { backgroundColor: '#9CA3AF' },
  bgBronze: { backgroundColor: '#B45309' },
  scoreInfo: { flex: 1 },
  scoreLevel: { fontSize: 24, fontWeight: '800', color: '#1F2937' },
  scorePoints: { fontSize: 15, color: '#6B7280', marginTop: 4, fontWeight: '500' },
  progressContainer: { marginBottom: 24 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  progressLabel: { fontSize: 14, color: '#4B5563', fontWeight: '500' },
  progressValue: { fontSize: 14, color: '#1F2937', fontWeight: '700' },
  progressBarBg: { height: 10, backgroundColor: '#E5E7EB', borderRadius: 5, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 5 },
  statsRow: { flexDirection: 'row', backgroundColor: '#F9FAFB', borderRadius: 16, padding: 16 },
  statBox: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: '#E5E7EB', marginVertical: 4 },
  statValue: { fontSize: 20, fontWeight: '700', color: '#4F46E5', marginBottom: 4 },
  statLabel: { fontSize: 12, color: '#6B7280', fontWeight: '500' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#1F2937', marginBottom: 16 },
  emptyState: { alignItems: 'center', backgroundColor: '#FFF', padding: 32, borderRadius: 16 },
  emptyText: { marginTop: 12, color: '#6B7280', fontSize: 15 },
  historyCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', padding: 16, borderRadius: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.03, shadowRadius: 8, elevation: 1 },
  historyIcon: { width: 48, height: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  historyInfo: { flex: 1 },
  historyBank: { fontSize: 16, fontWeight: '600', color: '#1F2937', marginBottom: 4 },
  historyVicinity: { fontSize: 13, color: '#6B7280', marginBottom: 4 },
  historyDate: { fontSize: 12, color: '#9CA3AF' },
  historyStatusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, marginLeft: 12 },
  historyStatusText: { color: '#FFF', fontSize: 11, fontWeight: '700' },
});
