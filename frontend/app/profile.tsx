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
  name: string;
  picture: string | null;
  karma_score: number;
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
          <Ionicons name="arrow-back" size={24} color="#1F2937" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Profile</Text>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutButtonHeader}>
          <Ionicons name="log-out-outline" size={24} color="#EF4444" />
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
                <Ionicons name="pencil" size={18} color="#4F46E5" />
              </TouchableOpacity>
            </View>
          )}
          <Text style={styles.userEmail}>{profile.user_id.length > 20 ? 'Google Authenticated User' : profile.user_id}</Text>
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
  
  profileCard: { backgroundColor: '#FFF', borderRadius: 20, padding: 24, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 12, elevation: 3, marginBottom: 24 },
  avatarContainer: { position: 'relative', marginBottom: 16 },
  avatarImage: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#E5E7EB' },
  avatarPlaceholder: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#E5E7EB', justifyContent: 'center', alignItems: 'center' },
  editAvatarBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#4F46E5', width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#FFF' },
  nameContainer: { flexDirection: 'row', alignItems: 'center' },
  userName: { fontSize: 22, fontWeight: '800', color: '#1F2937' },
  editNameIcon: { marginLeft: 8, padding: 4 },
  userEmail: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  editNameContainer: { width: '100%', alignItems: 'center' },
  nameInput: { backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 12, width: '80%', paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, color: '#1F2937', textAlign: 'center', marginBottom: 12 },
  editActions: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  cancelButton: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#F3F4F6' },
  cancelButtonText: { color: '#4B5563', fontWeight: '600' },
  saveButton: { paddingVertical: 8, paddingHorizontal: 24, borderRadius: 8, backgroundColor: '#4F46E5' },
  saveButtonText: { color: '#FFF', fontWeight: '600' },

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
