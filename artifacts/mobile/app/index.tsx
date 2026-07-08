import React, { useCallback, useEffect } from "react";
import {
  Platform,
  PermissionsAndroid,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useBle, Role, Status } from "@/hooks/useBle";
import { useColors } from "@/hooks/useColors";

async function requestAndroidPermissions(): Promise<void> {
  if (Platform.OS !== "android") return;
  await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);
}

function statusLabel(status: Status): string {
  switch (status) {
    case "idle": return "Ready";
    case "checking_ble": return "Checking BLE...";
    case "ble_unsupported": return "BLE Unsupported";
    case "advertising": return "Advertising...";
    case "scanning": return "Scanning...";
    case "connecting": return "Connecting...";
    case "connected": return "Connected";
    case "transferring": return "Transferring...";
    case "done": return "Done";
    case "error": return "Error";
    default: return "Idle";
  }
}

function statusColor(status: Status, colors: ReturnType<typeof useColors>): string {
  switch (status) {
    case "done": return colors.success;
    case "error":
    case "ble_unsupported": return colors.destructive;
    case "advertising":
    case "scanning":
    case "connecting":
    case "transferring": return colors.primary;
    default: return colors.mutedForeground;
  }
}

function HashBox({ label, hash, color }: { label: string; hash: string | null; color: string }) {
  const colors = useColors();
  if (!hash) return null;
  return (
    <View style={[styles.hashBox, { backgroundColor: colors.card, borderColor: color }]}>
      <Text style={[styles.hashLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.hashValue, { color }]} numberOfLines={2} selectable>
        {hash}
      </Text>
    </View>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state, setRole, play, stop, reset } = useBle();

  useEffect(() => {
    requestAndroidPermissions();
  }, []);

  const isActive = state.isRunning;
  const canPlay = state.role !== null && !isActive;

  const handleStop = useCallback(() => { void stop(); }, [stop]);
  const handleReset = useCallback(() => { void reset(); }, [reset]);
  const handlePlay = useCallback(() => { void play(); }, [play]);

  const hashesMatch =
    state.sentHash !== null &&
    state.receivedHash !== null &&
    state.sentHash === state.receivedHash;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + (Platform.OS === "web" ? 67 : 16),
          paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16),
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.blueIcon, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="bluetooth" size={22} color={colors.primary} />
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.foreground }]}>BLE 5.0 Tester</Text>
          {state.bleVersion && (
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              {state.bleVersion}
            </Text>
          )}
        </View>
      </View>

      {/* Role Selector */}
      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SELECT ROLE</Text>
        <View style={styles.roleRow}>
          {(["peripheral", "central"] as Role[]).map((role) => {
            const isSelected = state.role === role;
            const roleColor = role === "peripheral" ? colors.peripheral : colors.central;
            const icon = role === "peripheral" ? "radio" : "wifi";
            return (
              <TouchableOpacity
                key={role ?? "none"}
                testID={`role-${role}`}
                onPress={() => !isActive && setRole(role)}
                style={[
                  styles.roleButton,
                  {
                    backgroundColor: isSelected ? roleColor + "22" : colors.secondary,
                    borderColor: isSelected ? roleColor : colors.border,
                  },
                ]}
                activeOpacity={0.7}
                disabled={isActive}
              >
                <Feather name={icon as "radio" | "wifi"} size={20} color={isSelected ? roleColor : colors.mutedForeground} />
                <Text
                  style={[
                    styles.roleLabel,
                    { color: isSelected ? roleColor : colors.mutedForeground },
                  ]}
                >
                  {role === "peripheral" ? "Peripheral" : "Central"}
                </Text>
                <Text style={[styles.roleDesc, { color: colors.mutedForeground }]}>
                  {role === "peripheral" ? "Advertise & Send" : "Scan & Receive"}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Status Indicator */}
      <View
        style={[
          styles.statusRow,
          {
            backgroundColor: colors.card,
            borderColor: statusColor(state.status, colors) + "44",
          },
        ]}
      >
        {isActive ? (
          <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 10 }} />
        ) : (
          <View
            style={[
              styles.statusDot,
              { backgroundColor: statusColor(state.status, colors) },
            ]}
          />
        )}
        <Text style={[styles.statusText, { color: statusColor(state.status, colors) }]}>
          {statusLabel(state.status)}
        </Text>
        {state.role && (
          <Text style={[styles.roleTag, { color: colors.mutedForeground }]}>
            {state.role === "peripheral" ? "· Peripheral" : "· Central"}
          </Text>
        )}
      </View>

      {/* Hash Display */}
      {(state.sentHash || state.receivedHash) && (
        <View style={styles.hashSection}>
          <HashBox
            label="SENT (SHA-256)"
            hash={state.sentHash}
            color={colors.peripheral}
          />
          <HashBox
            label="RECEIVED (SHA-256)"
            hash={state.receivedHash}
            color={colors.central}
          />
          {hashesMatch && (
            <View style={[styles.matchBadge, { backgroundColor: colors.success + "22", borderColor: colors.success }]}>
              <Feather name="check-circle" size={14} color={colors.success} />
              <Text style={[styles.matchText, { color: colors.success }]}>
                Hashes match — transfer verified
              </Text>
            </View>
          )}
          {state.sentHash && state.receivedHash && !hashesMatch && (
            <View style={[styles.matchBadge, { backgroundColor: colors.destructive + "22", borderColor: colors.destructive }]}>
              <Feather name="alert-triangle" size={14} color={colors.destructive} />
              <Text style={[styles.matchText, { color: colors.destructive }]}>
                Hash mismatch — data error
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Log */}
      <ScrollView
        style={[styles.logBox, { backgroundColor: colors.card, borderColor: colors.border }]}
        contentContainerStyle={styles.logContent}
        showsVerticalScrollIndicator={false}
      >
        {state.logs.length === 0 ? (
          <Text style={[styles.logEmpty, { color: colors.mutedForeground }]}>
            Select a role and press Play to begin.
          </Text>
        ) : (
          state.logs.map((line, i) => (
            <Text key={i} style={[styles.logLine, { color: i === 0 ? colors.foreground : colors.mutedForeground }]} selectable>
              {line}
            </Text>
          ))
        )}
      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          testID="btn-play"
          onPress={isActive ? handleStop : handlePlay}
          disabled={!canPlay && !isActive}
          activeOpacity={0.8}
          style={[
            styles.playButton,
            {
              backgroundColor: isActive
                ? colors.destructive
                : canPlay
                ? colors.primary
                : colors.secondary,
              opacity: !canPlay && !isActive ? 0.4 : 1,
            },
          ]}
        >
          {isActive ? (
            <Feather name="square" size={22} color="#fff" />
          ) : (
            <Feather name="play" size={22} color={canPlay ? colors.primaryForeground : colors.mutedForeground} />
          )}
          <Text
            style={[
              styles.playLabel,
              {
                color: isActive
                  ? "#fff"
                  : canPlay
                  ? colors.primaryForeground
                  : colors.mutedForeground,
              },
            ]}
          >
            {isActive ? "Stop" : "Play"}
          </Text>
        </TouchableOpacity>

        {(state.status !== "idle" || state.logs.length > 0) && !isActive && (
          <TouchableOpacity
            testID="btn-reset"
            onPress={handleReset}
            activeOpacity={0.7}
            style={[styles.resetButton, { borderColor: colors.border }]}
          >
            <Feather name="refresh-cw" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
    gap: 12,
  },
  blueIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  section: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    marginBottom: 12,
  },
  roleRow: {
    flexDirection: "row",
    gap: 10,
  },
  roleButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1.5,
    padding: 14,
    alignItems: "center",
    gap: 6,
  },
  roleLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  roleDesc: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  roleTag: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  hashSection: {
    gap: 8,
    marginBottom: 12,
  },
  hashBox: {
    borderRadius: 10,
    borderWidth: 1.5,
    padding: 12,
  },
  hashLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  hashValue: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
  },
  matchBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  matchText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  logBox: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 14,
  },
  logContent: {
    padding: 12,
    gap: 3,
  },
  logEmpty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 20,
    lineHeight: 20,
  },
  logLine: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  playButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: 14,
  },
  playLabel: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  resetButton: {
    width: 52,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
