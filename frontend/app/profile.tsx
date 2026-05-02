import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Image, TextInput, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import * as ImagePicker from 'expo-image-picker';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://neurocash.vercel.app";

const STATUS_ICONS: Record<string, any> = {
  cash: 'cash',
  low_cash: 'alert-circle',
  long_queue: 'people',
  no_cash: 'close-circle',
};

const STATUS_COLORS: Record<string, string> = {
  cash: '#10B981',
  low_cash: '#F59E0B',
  long_queue: '#6366F1',
  no_cash: '#F43F5E',
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
  name: string;
  picture: string | null;
  karma_score: number;
  points: number;
  report_count: number;
  karma_level: string;
}

export default function ProfileScreen() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [history, setHistory] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Edit State
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchProfileData = async () => {
    try {
      const token = await AsyncStorage.getItem('googleToken');
      if (token) {
        const response = await axios.get(`${BACKEND_URL}/api/user/profile`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = response.data;
        setProfile({
          user_id: data.user_id || 'user',
          name: data.name || 'Guest',
          picture: data.picture || null,
          karma_score: data.karma_score || 1.0,
          points: data.points || 0,
          report_count: data.report_count || 0,
          karma_level: data.karma_level || 'Bronze'
        });
        setEditName(data.name || 'Guest');
        
        try {
           const historyRes = await axios.get(`${BACKEND_URL}/api/user/history?user_id=${data.user_id}`, {
              headers: { Authorization: `Bearer ${token}` }
           });
           setHistory(historyRes.data.reports || []);
        } catch (e) {
           setHistory([]);
        }
      } else {
        setProfile({
          user_id: 'guest_user_123',
          name: 'Guest',
          picture: null,
          karma_score: 1.0,
          points: 0,
          report_count: 0,
          karma_level: 'Bronze'
        });
        setEditName('Guest');
        setHistory([]);
      }
    } catch (error: any) {
      console.error('Error fetching profile:', error);
      // Fallback to Guest mode if there's an error (e.g. invalid/expired token)
      setProfile({
        user_id: 'guest_user_123',
        name: 'Guest',
        picture: null,
        karma_score: 1.0,
        points: 0,
        report_count: 0,
        karma_level: 'Bronze'
      });
      setEditName('Guest');
      setHistory([]);
      
      // If it's a 401 Unauthorized, clear the invalid token
      if (error.response?.status === 401) {
        AsyncStorage.removeItem('googleToken');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfileData();
  }, []);

  const handleLogout = async () => {
    await AsyncStorage.removeItem('googleToken');
    router.replace('/');
  };

  const pickImage = async () => {
    // Request permissions
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    
    if (permissionResult.granted === false) {
      if (Platform.OS !== 'web') {
        Alert.alert("Permission required", "You need to allow access to your photos to change your profile picture.");
      } else {
        window.alert("Permission required: You need to allow access to your photos.");
      }
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.2, // Keep it small for Vercel/MongoDB limits
      base64: true, // Crucial for sending to Vercel easily
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      const asset = result.assets[0];
      const base64Image = `data:image/jpeg;base64,${asset.base64}`;
      handleSaveProfile(editName, base64Image);
    }
  };

  const handleSaveProfile = async (newName: string, newPicture?: string) => {
    if (!profile) return;
    setSaving(true);
    try {
      const token = await AsyncStorage.getItem('googleToken');
      const payload: any = { name: newName };
      if (newPicture) {
        payload.picture = newPicture;
      }

      await axios.put(`${BACKEND_URL}/api/user/profile`, payload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      // Update local state
      setProfile({
        ...profile,
        name: newName,
        picture: newPicture || profile.picture
      });
      setIsEditing(false);
    } catch (error) {
      console.error("Error saving profile", error);
      if (Platform.OS !== 'web') {
        Alert.alert("Error", "Could not save profile details.");
      }
    } finally {
      setSaving(false);
    }
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
  
  if (karma < 2.0) {
    progress = (karma - 1.0) / (2.0 - 1.0);
    nextRank = 'Silver';
  } else if (karma < 5.0) {
    progress = (karma - 2.0) / (5.0 - 2.0);
    nextRank = 'Gold';
  } else {
    progress = 1;
    nextRank = 'Max Rank';
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButtonHeader}>
          <Ionicons name="arrow-back" size={24} color="#F8FAFC" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Profile</Text>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutButtonHeader}>
          <Ionicons name="log-out-outline" size={24} color="#F43F5E" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* Profile Card Section */}
        <View style={styles.profileCard}>
          <TouchableOpacity style={styles.avatarContainer} onPress={pickImage} disabled={saving}>
            {profile.picture ? (
              <Image source={{ uri: profile.picture }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Ionicons name="person" size={48} color="#9CA3AF" />
              </View>
            )}
            <View style={styles.editAvatarBadge}>
              <Ionicons name="camera" size={14} color="#FFF" />
            </View>
          </TouchableOpacity>
          
          {isEditing ? (
            <View style={styles.editNameContainer}>
              <TextInput
                style={styles.nameInput}
                value={editName}
                onChangeText={setEditName}
                placeholder="Enter your name"
                placeholderTextColor="#9CA3AF"
                autoFocus
              />
              <View style={styles.editActions}>
                <TouchableOpacity style={styles.cancelButton} onPress={() => { setIsEditing(false); setEditName(profile.name); }}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveButton} onPress={() => handleSaveProfile(editName)} disabled={saving}>
                  {saving ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.saveButtonText}>Save</Text>}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={styles.nameContainer}>
              <Text style={styles.userName}>{profile.name}</Text>
              <TouchableOpacity onPress={() => setIsEditing(true)} style={styles.editNameIcon}>
                <Ionicons name="pencil" size={18} color="#6366F1" />
              </TouchableOpacity>
            </View>
          )}
          <Text style={styles.userEmail}>{profile.user_id.length > 20 ? 'Neural Verified Account' : profile.user_id}</Text>
        </View>

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
              <View style={styles.pointsRow}>
                <Text style={styles.scorePoints}>{karma.toFixed(1)} Karma</Text>
                <View style={styles.pointsDot} />
                <Text style={styles.scorePoints}>{profile.points} Points</Text>
              </View>
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
  loadingContainer: { flex: 1, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 16, color: '#94A3B8', marginBottom: 16 },
  backButton: { backgroundColor: '#6366F1', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  backButtonText: { color: '#FFF', fontWeight: '600' },
  container: { flex: 1, backgroundColor: '#0F172A' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 16, backgroundColor: '#1E293B', borderBottomWidth: 1, borderBottomColor: '#334155' },
  backButtonHeader: { padding: 4 },
  logoutButtonHeader: { padding: 4 },
  headerTitle: { fontSize: 20, fontWeight: '800', color: '#F8FAFC' },
  scrollContent: { padding: 16 },
  
  profileCard: { backgroundColor: '#1E293B', borderRadius: 24, padding: 24, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 4, marginBottom: 24, borderWidth: 1, borderColor: '#334155' },
  avatarContainer: { position: 'relative', marginBottom: 16 },
  avatarImage: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#334155', borderWidth: 3, borderColor: '#6366F1' },
  avatarPlaceholder: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center' },
  editAvatarBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#6366F1', width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#1E293B' },
  nameContainer: { flexDirection: 'row', alignItems: 'center' },
  userName: { fontSize: 24, fontWeight: '800', color: '#F8FAFC' },
  editNameIcon: { marginLeft: 8, padding: 4 },
  userEmail: { fontSize: 14, color: '#94A3B8', marginTop: 4, fontWeight: '500' },
  editNameContainer: { width: '100%', alignItems: 'center' },
  nameInput: { backgroundColor: '#0F172A', borderWidth: 1, borderColor: '#334155', borderRadius: 12, width: '85%', paddingHorizontal: 16, paddingVertical: 12, fontSize: 16, color: '#F8FAFC', textAlign: 'center', marginBottom: 12 },
  editActions: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  cancelButton: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, backgroundColor: '#334155' },
  cancelButtonText: { color: '#94A3B8', fontWeight: '600' },
  saveButton: { paddingVertical: 8, paddingHorizontal: 24, borderRadius: 10, backgroundColor: '#6366F1' },
  saveButtonText: { color: '#FFF', fontWeight: '600' },
  
  scoreboardCard: { backgroundColor: '#1E293B', borderRadius: 24, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 4, marginBottom: 24, borderWidth: 1, borderColor: '#334155' },
  scoreHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  badgeIcon: { width: 68, height: 68, borderRadius: 34, justifyContent: 'center', alignItems: 'center', marginRight: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
  bgGold: { backgroundColor: '#F59E0B' },
  bgSilver: { backgroundColor: '#94A3B8' },
  bgBronze: { backgroundColor: '#B45309' },
  scoreInfo: { flex: 1 },
  scoreLevel: { fontSize: 26, fontWeight: '800', color: '#F8FAFC' },
  pointsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  pointsDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#475569', marginHorizontal: 10 },
  scorePoints: { fontSize: 15, color: '#94A3B8', fontWeight: '600' },
  progressContainer: { marginBottom: 24 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  progressLabel: { fontSize: 14, color: '#94A3B8', fontWeight: '600' },
  progressValue: { fontSize: 14, color: '#F8FAFC', fontWeight: '800' },
  progressBarBg: { height: 12, backgroundColor: '#0F172A', borderRadius: 6, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 6 },
  statsRow: { flexDirection: 'row', backgroundColor: '#0F172A', borderRadius: 18, padding: 18 },
  statBox: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: '#1E293B', marginVertical: 4 },
  statValue: { fontSize: 22, fontWeight: '800', color: '#6366F1', marginBottom: 4 },
  statLabel: { fontSize: 12, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase' },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: '#F8FAFC', marginBottom: 16, marginLeft: 4 },
  emptyState: { alignItems: 'center', backgroundColor: '#1E293B', padding: 40, borderRadius: 24, borderWidth: 1, borderColor: '#334155' },
  emptyText: { marginTop: 12, color: '#94A3B8', fontSize: 15, fontWeight: '500' },
  historyCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', padding: 16, borderRadius: 20, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 6, elevation: 2, borderWidth: 1, borderColor: '#334155' },
  historyIcon: { width: 52, height: 52, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  historyInfo: { flex: 1 },
  historyBank: { fontSize: 17, fontWeight: '700', color: '#F8FAFC', marginBottom: 4 },
  historyVicinity: { fontSize: 13, color: '#94A3B8', marginBottom: 4 },
  historyDate: { fontSize: 12, color: '#475569', fontWeight: '500' },
  historyStatusBadge: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, marginLeft: 12 },
  historyStatusText: { color: '#FFF', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
});
