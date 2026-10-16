import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Alert,
  Easing,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Vibration,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Location from "expo-location";

// ── Theme: Spotify Dark + Red ──
const C = {
  bg: "#0A0A0A",
  bgCard: "#1A1A1A",
  bgCard2: "#242424",
  bgElevated: "#2A2A2A",
  red: "#FF1A1A",
  redDark: "#CC0000",
  redSoft: "#FF3B30",
  redGlow: "rgba(255,26,26,0.22)",
  white: "#FFFFFF",
  grey: "#A7A7A7",
  grey2: "#6A6A6A",
  green: "#1DB954",
  border: "#282828",
};

const PRESETS = ["I fell", "Intruder", "Sick", "Need help", "Can't speak"];
const DEFAULT_MSG = "SOS — I need help. My live location attached.";

const INITIAL_CONTACTS = [
  { id: "1", name: "Dad", phone: "", color: "#1DB954", online: true, initial: "D" },
  { id: "2", name: "Sister", phone: "", color: "#E13300", online: true, initial: "S" },
  { id: "3", name: "Alex", phone: "", color: "#8C5DFF", online: false, initial: "A" },
];

function formatTime(d = new Date()) {
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function App() {
  // Tabs: home | circle | history | settings
  const [tab, setTab] = useState("home");
  const [contacts, setContacts] = useState(INITIAL_CONTACTS);
  const [message, setMessage] = useState("");
  const [defaultMessage, setDefaultMessage] = useState(DEFAULT_MSG);
  const [medicalNotes, setMedicalNotes] = useState("");
  const [history, setHistory] = useState([]);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");

  // SOS flow
  const [sosMode, setSosMode] = useState(null); // "all" | contactId | null
  const [sosPhase, setSosPhase] = useState("idle"); // idle | holding | countdown | sending | success
  const [countdown, setCountdown] = useState(5);
  const [lastSent, setLastSent] = useState(null);
  const [selectSheet, setSelectSheet] = useState(false);
  const [pendingContactId, setPendingContactId] = useState(null);

  // Animations
  const pulse = useRef(new Animated.Value(1)).current;
  const holdProgress = useRef(new Animated.Value(0)).current;
  const countdownScale = useRef(new Animated.Value(1)).current;
  const holdTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const isHoldingRef = useRef(false);

  // Pulse for idle SOS
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.06, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // Countdown tick animation
  useEffect(() => {
    if (sosPhase !== "countdown") return;
    Animated.sequence([
      Animated.timing(countdownScale, { toValue: 1.35, duration: 120, useNativeDriver: true }),
      Animated.timing(countdownScale, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }),
    ]).start();
  }, [countdown]);

  function clearTimers() {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    holdTimerRef.current = null;
    countdownTimerRef.current = null;
  }

  useEffect(() => () => clearTimers(), []);

  function startHold(mode) {
    if (sosPhase !== "idle") return;
    isHoldingRef.current = true;
    setSosMode(mode);
    setSosPhase("holding");
    holdProgress.setValue(0);
    Animated.timing(holdProgress, {
      toValue: 1,
      duration: 3000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && isHoldingRef.current) {
        try { Vibration.vibrate(200); } catch {}
        startCountdown();
      }
    });
  }

  function cancelHold() {
    isHoldingRef.current = false;
    Animated.timing(holdProgress, {
      toValue: 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
    if (sosPhase === "holding") {
      setSosPhase("idle");
      setSosMode(null);
    }
    clearTimers();
  }

  function startCountdown() {
    setSosPhase("countdown");
    setCountdown(5);
    try { Vibration.vibrate([0, 120, 80, 120]); } catch {}
    countdownTimerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
          doSend();
          return 0;
        }
        try { Vibration.vibrate(60); } catch {}
        return c - 1;
      });
    }, 1000);
  }

  function cancelCountdown() {
    clearTimers();
    isHoldingRef.current = false;
    holdProgress.setValue(0);
    setSosPhase("idle");
    setSosMode(null);
    setCountdown(5);
  }

  async function doSend() {
    setSosPhase("sending");
    let locationLink = "Location unavailable (no GPS permission)";
    let coords = null;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === "granted") {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        coords = pos.coords;
        locationLink = `https://maps.google.com/?q=${coords.latitude},${coords.longitude}`;
      }
    } catch (e) {
      locationLink = "Location unavailable";
    }

    const msg = (message.trim() || defaultMessage).trim();
    const targets = sosMode === "all" ? contacts : contacts.filter((c) => c.id === sosMode);
    const targetLabel = sosMode === "all" ? "Everyone" : targets[0]?.name || "—";

    const entry = {
      id: String(Date.now()),
      time: formatTime(new Date()),
      targets: sosMode === "all" ? "All" : targetLabel,
      message: msg,
      locationLink,
      coords,
      medicalNotes: medicalNotes.trim() || null,
    };
    setHistory((h) => [entry, ...h]);
    setLastSent(entry);
    setSosPhase("success");
    try { Vibration.vibrate([0, 180, 60, 180, 60, 300]); } catch {}
  }

  function closeSuccess() {
    setSosPhase("idle");
    setSosMode(null);
    setCountdown(5);
    holdProgress.setValue(0);
  }

  function shareVia(type) {
    if (!lastSent) return;
    const smsBody = encodeURIComponent(
      `${lastSent.message}\n${lastSent.locationLink}\n${lastSent.medicalNotes ? "Medical: " + lastSent.medicalNotes + "\n" : ""}Sent: ${lastSent.time}`
    );
    if (type === "sms") {
      const url = Platform.OS === "ios" ? `sms:&body=${smsBody}` : `sms:?body=${smsBody}`;
      Linking.openURL(url).catch(() => Alert.alert("SMS", "Could not open SMS app."));
    } else if (type === "whatsapp") {
      Linking.openURL(`https://wa.me/?text=${smsBody}`).catch(() => Alert.alert("WhatsApp", "Could not open WhatsApp."));
    }
  }

  function callEmergency() {
    Alert.alert("Call Emergency", "Call 112 / 911 ?", [
      { text: "Cancel", style: "cancel" },
      { text: "Call 112", onPress: () => Linking.openURL("tel:112").catch(() => {}) },
      { text: "Call 911", onPress: () => Linking.openURL("tel:911").catch(() => {}) },
    ]);
  }

  // ── Hold progress ring width ──
  const holdWidth = holdProgress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  // ── Screens ──
  const HomeScreen = (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Emergency SOS</Text>
        <Text style={styles.headerSub}>Dark • Red • Ready</Text>
      </View>

      {/* Trusted Circle preview — Spotify playlist cards */}
      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>Your Trusted Circle</Text>
        <Pressable onPress={() => setTab("circle")}>
          <Text style={styles.seeAll}>See all</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cardsRow}>
        {contacts.map((c) => (
          <View key={c.id} style={styles.contactCard}>
            <View style={[styles.avatar, { backgroundColor: c.color }]}>
              <Text style={styles.avatarText}>{c.initial}</Text>
              <View style={[styles.onlineDot, { backgroundColor: c.online ? C.green : C.grey2 }]} />
            </View>
            <Text style={styles.cardName} numberOfLines={1}>{c.name}</Text>
            <Text style={[styles.cardSub, { color: c.online ? C.green : C.grey }]}>{c.online ? "● online" : "○ offline"}</Text>
          </View>
        ))}
        <Pressable onPress={() => setTab("circle")} style={[styles.contactCard, styles.addCard]}>
          <View style={styles.addAvatar}><Text style={styles.addPlus}>＋</Text></View>
          <Text style={styles.cardName}>Add</Text>
          <Text style={styles.cardSub}>New contact</Text>
        </Pressable>
      </ScrollView>

      {/* Message box — always visible */}
      <View style={styles.messageCard}>
        <View style={styles.messageHead}>
          <Text style={styles.messageLabel}>✎  Message (optional)</Text>
          {!!message && (
            <Pressable onPress={() => setMessage("")}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          )}
        </View>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder={defaultMessage}
          placeholderTextColor={C.grey2}
          style={styles.messageInput}
          multiline
          maxLength={200}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {PRESETS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setMessage((m) => (m ? m + " " : "") + p)}
              style={styles.chip}
            >
              <Text style={styles.chipText}>{p}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={styles.hint}>This message + your live location will be sent with SOS. Leave empty to use default.</Text>
      </View>

      {/* BIG SOS TO ALL */}
      <View style={styles.sosWrap}>
        <Animated.View style={[styles.pulseRing, { transform: [{ scale: pulse }] }]} />
        <Pressable
          onPressIn={() => startHold("all")}
          onPressOut={cancelHold}
          style={({ pressed }) => [styles.sosBig, pressed && { opacity: 0.96 }]}
        >
          <View style={styles.sosBigInner}>
            <Text style={styles.sosBigTitle}>SOS TO ALL</Text>
            <Text style={styles.sosBigSub}>Hold 3 sec</Text>
          </View>
          {/* hold fill */}
          <Animated.View style={[styles.holdFill, { width: holdWidth }]} />
        </Pressable>
        <Text style={styles.holdHint}>
          {sosPhase === "holding" && sosMode === "all" ? "Keep holding..." : "Sends to everyone in your Circle"}
        </Text>
      </View>

      {/* Smaller SOS to Someone */}
      <Pressable
        onPress={() => setSelectSheet(true)}
        style={styles.sosSmall}
      >
        <View style={styles.sosSmallDot} />
        <Text style={styles.sosSmallText}>SOS to Someone…</Text>
        <Text style={styles.sosSmallArrow}>›</Text>
      </Pressable>

      {/* Emergency call helper — not replacement */}
      <Pressable onPress={callEmergency} style={styles.callEmergency}>
        <Text style={styles.callEmergencyText}>📞  Call Emergency  112 / 911</Text>
      </Pressable>

      <Text style={styles.footer}>App is a helper — always call 112/911 in real danger. Hold → Countdown → Send.</Text>
    </ScrollView>
  );

  const CircleScreen = (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.pageTitle}>Trusted Circle</Text>
      <Text style={styles.pageSub}>Invite must Accept. They can leave anytime. Tap to edit.</Text>

      {contacts.map((c) => (
        <View key={c.id} style={styles.circleRow}>
          <View style={[styles.avatarSm, { backgroundColor: c.color }]}>
            <Text style={styles.avatarSmText}>{c.initial}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.circleName}>{c.name}</Text>
            <Text style={styles.circlePhone}>{c.phone || "No phone — add to enable SMS"}</Text>
          </View>
          <View style={[styles.onlineDotLg, { backgroundColor: c.online ? C.green : C.grey2 }]} />
          <Pressable
            onPress={() => {
              Alert.alert("Remove contact?", `Remove ${c.name} from your Circle?`, [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: () => setContacts((prev) => prev.filter((x) => x.id !== c.id)) },
              ]);
            }}
            style={styles.removeBtn}
          >
            <Text style={styles.removeText}>✕</Text>
          </Pressable>
        </View>
      ))}

      <View style={styles.addBox}>
        <Text style={styles.addTitle}>Add contact</Text>
        <TextInput value={addName} onChangeText={setAddName} placeholder="Name" placeholderTextColor={C.grey2} style={styles.input} />
        <TextInput
          value={addPhone}
          onChangeText={setAddPhone}
          placeholder="Phone (optional, for SMS fallback)"
          placeholderTextColor={C.grey2}
          style={styles.input}
          keyboardType="phone-pad"
        />
        <Pressable
          onPress={() => {
            if (!addName.trim()) return Alert.alert("Name required");
            const colors = ["#1DB954", "#E13300", "#8C5DFF", "#FF6B00", "#00B8D4"];
            setContacts((prev) => [
              ...prev,
              {
                id: String(Date.now()),
                name: addName.trim(),
                phone: addPhone.trim(),
                color: colors[prev.length % colors.length],
                online: false,
                initial: addName.trim()[0].toUpperCase(),
              },
            ]);
            setAddName("");
            setAddPhone("");
          }}
          style={styles.addBtn}
        >
          <Text style={styles.addBtnText}>＋  Add to Circle</Text>
        </Pressable>
        <Text style={styles.hint}>V1 stores locally on device. Backend + invite/Accept comes next.</Text>
      </View>
    </ScrollView>
  );

  const HistoryScreen = (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.pageTitle}>History</Text>
      <Text style={styles.pageSub}>Past SOS events on this device.</Text>
      {history.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyEmoji}>🕊️</Text>
          <Text style={styles.emptyTitle}>No SOS yet</Text>
          <Text style={styles.emptySub}>When you send one, it appears here with location + time.</Text>
        </View>
      ) : (
        history.map((h) => (
          <View key={h.id} style={styles.historyCard}>
            <View style={styles.historyHead}>
              <Text style={styles.historyTargets}>{h.targets}</Text>
              <Text style={styles.historyTime}>{h.time}</Text>
            </View>
            <Text style={styles.historyMsg}>{h.message}</Text>
            {h.medicalNotes ? <Text style={styles.historyMedical}>🩺 {h.medicalNotes}</Text> : null}
            <Pressable onPress={() => Linking.openURL(h.locationLink).catch(() => {})}>
              <Text style={styles.historyLink}>{h.locationLink}</Text>
            </Pressable>
          </View>
        ))
      )}
      {history.length > 0 && (
        <Pressable onPress={() => setHistory([])} style={styles.clearHistory}>
          <Text style={styles.clearHistoryText}>Clear history</Text>
        </Pressable>
      )}
    </ScrollView>
  );

  const SettingsScreen = (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.pageTitle}>Settings</Text>

      <Text style={styles.settingLabel}>Default message (used if you send with empty box)</Text>
      <TextInput
        value={defaultMessage}
        onChangeText={setDefaultMessage}
        placeholder="Default SOS message"
        placeholderTextColor={C.grey2}
        style={styles.inputLg}
        multiline
      />

      <Text style={styles.settingLabel}>Medical notes (optional, sent with every SOS)</Text>
      <TextInput
        value={medicalNotes}
        onChangeText={setMedicalNotes}
        placeholder="e.g. Asthma, allergy to penicillin, blood type O+"
        placeholderTextColor={C.grey2}
        style={styles.inputLg}
        multiline
      />

      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>How SOS works</Text>
        <Text style={styles.infoText}>1. Type a message or tap a chip (or leave empty)</Text>
        <Text style={styles.infoText}>2. Hold SOS 3 sec — don't let go early</Text>
        <Text style={styles.infoText}>3. Release → 5 sec countdown with Cancel</Text>
        <Text style={styles.infoText}>4. At 0 it sends location + message + time to your Circle</Text>
        <Text style={[styles.infoText, { marginTop: 8, color: C.grey }]}>
          Port: 5174  •  Same WiFi only for Expo preview  •  Real SOS works on any internet
        </Text>
      </View>

      <Pressable onPress={callEmergency} style={[styles.callEmergency, { marginTop: 16 }]}>
        <Text style={styles.callEmergencyText}>📞  Call Emergency  112 / 911</Text>
      </Pressable>
    </ScrollView>
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Top safe area spacer */}
      <View style={styles.topSpacer} />

      {tab === "home" && HomeScreen}
      {tab === "circle" && CircleScreen}
      {tab === "history" && HistoryScreen}
      {tab === "settings" && SettingsScreen}

      {/* Bottom nav — Spotify style */}
      <View style={styles.tabBar}>
        {[
          { id: "home", label: "Home", icon: "⌂" },
          { id: "circle", label: "Circle", icon: "◯" },
          { id: "history", label: "History", icon: "↻" },
          { id: "settings", label: "Settings", icon: "⚙" },
        ].map((t) => (
          <Pressable key={t.id} onPress={() => setTab(t.id)} style={styles.tabItem}>
            <Text style={[styles.tabIcon, tab === t.id && styles.tabActive]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.id && styles.tabActive]}>{t.label}</Text>
            {tab === t.id && <View style={styles.tabDot} />}
          </Pressable>
        ))}
      </View>

      {/* Hold overlay */}
      {sosPhase === "holding" && (
        <View style={styles.countdownOverlay} pointerEvents="none">
          <Text style={styles.countdownLabel}>KEEP HOLDING</Text>
          <View style={styles.holdBarTrack}>
            <Animated.View style={[styles.holdBarFill, { width: holdWidth }]} />
          </View>
          <Text style={styles.countdownHint}>Release early to cancel • 3 sec to arm</Text>
        </View>
      )}

      {/* Countdown overlay */}
      {sosPhase === "countdown" && (
        <View style={styles.countdownOverlay}>
          <Text style={styles.countdownLabel}>SENDING SOS IN</Text>
          <Animated.View style={{ transform: [{ scale: countdownScale }] }}>
            <Text style={styles.countdownNumber}>{countdown}</Text>
          </Animated.View>
          <Text style={styles.countdownHint}>
            To: {sosMode === "all" ? "Everyone in Circle" : contacts.find((c) => c.id === sosMode)?.name}
          </Text>
          <Pressable onPress={cancelCountdown} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>CANCEL</Text>
          </Pressable>
          <Text style={styles.countdownHint}>Tap CANCEL to stop — no message sent</Text>
        </View>
      )}

      {/* Sending */}
      {sosPhase === "sending" && (
        <View style={styles.countdownOverlay}>
          <Text style={styles.countdownLabel}>SENDING…</Text>
          <Text style={styles.countdownHint}>Getting location and saving…</Text>
        </View>
      )}

      {/* Success sheet — Spotify bottom sheet style */}
      <Modal visible={sosPhase === "success"} transparent animationType="slide" onRequestClose={closeSuccess}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSuccess} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>✅ SOS Sent</Text>
            {lastSent && (
              <>
                <Text style={styles.sheetSub}>To: {lastSent.targets} • {lastSent.time}</Text>
                <Text style={styles.sheetMsg}>"{lastSent.message}"</Text>
                <Pressable onPress={() => Linking.openURL(lastSent.locationLink).catch(() => {})}>
                  <Text style={styles.sheetLink}>{lastSent.locationLink}</Text>
                </Pressable>
                {lastSent.medicalNotes ? <Text style={styles.sheetMedical}>🩺 {lastSent.medicalNotes}</Text> : null}
                <View style={styles.sheetActions}>
                  <Pressable onPress={() => shareVia("sms")} style={styles.sheetBtn}>
                    <Text style={styles.sheetBtnText}>💬 SMS fallback</Text>
                  </Pressable>
                  <Pressable onPress={() => shareVia("whatsapp")} style={[styles.sheetBtn, styles.sheetBtnGreen]}>
                    <Text style={styles.sheetBtnText}>🟢 WhatsApp</Text>
                  </Pressable>
                </View>
                <Text style={styles.sheetHint}>Also try SMS/WhatsApp if contacts have no internet.</Text>
              </>
            )}
            <Pressable onPress={closeSuccess} style={styles.sheetClose}>
              <Text style={styles.sheetCloseText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Select contact sheet for SOS to Someone */}
      <Modal visible={selectSheet} transparent animationType="slide" onRequestClose={() => setSelectSheet(false)}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectSheet(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>SOS to Someone</Text>
            <Text style={styles.sheetSub}>Pick one person — then hold 3 sec → countdown → send only to them.</Text>
            {message.trim() ? <Text style={styles.sheetMsg}>"{message.trim()}"</Text> : <Text style={styles.sheetSub}>Message: {defaultMessage}</Text>}
            <View style={{ gap: 10, marginTop: 12 }}>
              {contacts.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => {
                    setPendingContactId(c.id);
                    setSelectSheet(false);
                    // small delay so sheet closes before hold
                    setTimeout(() => startHold(c.id), 350);
                  }}
                  style={styles.pickRow}
                >
                  <View style={[styles.avatarSm, { backgroundColor: c.color }]}><Text style={styles.avatarSmText}>{c.initial}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickName}>{c.name}</Text>
                    <Text style={styles.pickPhone}>{c.phone || "No phone"}</Text>
                  </View>
                  <Text style={styles.pickArrow}>›</Text>
                </Pressable>
              ))}
            </View>
            <Pressable onPress={() => setSelectSheet(false)} style={[styles.sheetClose, { marginTop: 16 }]}>
              <Text style={styles.sheetCloseText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Pending single hold hint */}
      {pendingContactId && sosPhase === "idle" && (
        <View style={{ height: 0 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  topSpacer: { height: Platform.OS === "web" ? 20 : 44, backgroundColor: C.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 28, paddingHorizontal: 16 },

  header: { paddingTop: 8, paddingBottom: 10 },
  headerTitle: { color: C.white, fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  headerSub: { color: C.grey, fontSize: 12, marginTop: 2, letterSpacing: 1, textTransform: "uppercase" },

  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, marginBottom: 10 },
  sectionTitle: { color: C.white, fontSize: 18, fontWeight: "700" },
  seeAll: { color: C.grey, fontSize: 13, fontWeight: "600" },
  cardsRow: { gap: 10, paddingRight: 8 },
  contactCard: {
    width: 92, backgroundColor: C.bgCard, borderRadius: 14, padding: 10, alignItems: "center",
    borderWidth: 1, borderColor: C.border,
  },
  addCard: { borderStyle: "dashed", borderColor: C.grey2, backgroundColor: "transparent" },
  avatar: {
    width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 8,
  },
  avatarText: { color: C.white, fontWeight: "800", fontSize: 20 },
  onlineDot: { position: "absolute", right: 2, bottom: 2, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: C.bgCard },
  cardName: { color: C.white, fontWeight: "700", fontSize: 12, textAlign: "center" },
  cardSub: { fontSize: 10, marginTop: 2 },

  addAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.bgCard2, alignItems: "center", justifyContent: "center", marginBottom: 8, borderWidth: 1, borderColor: C.border },
  addPlus: { color: C.grey, fontSize: 24, fontWeight: "600" },

  messageCard: {
    backgroundColor: C.bgCard, borderRadius: 16, padding: 14, marginTop: 14,
    borderWidth: 1, borderColor: C.border,
  },
  messageHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  messageLabel: { color: C.white, fontWeight: "700", fontSize: 13 },
  clearText: { color: C.redSoft, fontWeight: "700", fontSize: 12 },
  messageInput: {
    backgroundColor: C.bgCard2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    color: C.white, fontSize: 14, minHeight: 44, borderWidth: 1, borderColor: C.border,
  },
  chipsRow: { gap: 8, marginTop: 10 },
  chip: { backgroundColor: C.bgElevated, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: C.border },
  chipText: { color: C.white, fontSize: 12, fontWeight: "600" },
  hint: { color: C.grey, fontSize: 11, marginTop: 8, lineHeight: 14 },

  sosWrap: { alignItems: "center", marginTop: 18 },
  pulseRing: {
    position: "absolute", top: 8, width: 200, height: 200, borderRadius: 100,
    backgroundColor: C.redGlow, borderWidth: 1, borderColor: "rgba(255,26,26,0.18)",
  },
  sosBig: {
    width: 180, height: 180, borderRadius: 90, backgroundColor: C.red,
    alignItems: "center", justifyContent: "center",
    shadowColor: C.red, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
    elevation: 8, overflow: "hidden",
  },
  sosBigInner: { alignItems: "center", zIndex: 1 },
  sosBigTitle: { color: C.white, fontWeight: "900", fontSize: 22, letterSpacing: 1 },
  sosBigSub: { color: "rgba(255,255,255,0.9)", fontWeight: "700", fontSize: 12, marginTop: 4, letterSpacing: 0.6 },
  holdFill: { position: "absolute", left: 0, bottom: 0, height: 6, backgroundColor: "rgba(255,255,255,0.9)" },
  holdHint: { color: C.grey, fontSize: 12, marginTop: 10, fontWeight: "600" },

  sosSmall: {
    marginTop: 14, backgroundColor: C.bgCard, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 18,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    borderWidth: 1, borderColor: C.border,
  },
  sosSmallDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.red },
  sosSmallText: { color: C.white, fontWeight: "700", fontSize: 14 },
  sosSmallArrow: { color: C.grey, fontSize: 18, marginLeft: 4 },

  callEmergency: {
    marginTop: 12, backgroundColor: "#1A1A1A", borderRadius: 12, paddingVertical: 12, alignItems: "center",
    borderWidth: 1, borderColor: "#2A2A2A",
  },
  callEmergencyText: { color: C.white, fontWeight: "700", fontSize: 13 },
  footer: { color: C.grey2, fontSize: 11, textAlign: "center", marginTop: 10, lineHeight: 14 },

  // Tab bar
  tabBar: {
    flexDirection: "row", backgroundColor: "#0F0F0F", borderTopWidth: 1, borderTopColor: C.border,
    paddingVertical: 8, paddingBottom: Platform.OS === "ios" ? 20 : 10,
  },
  tabItem: { flex: 1, alignItems: "center", gap: 2, paddingTop: 2 },
  tabIcon: { color: C.grey, fontSize: 18, fontWeight: "700" },
  tabLabel: { color: C.grey, fontSize: 10, fontWeight: "600", marginTop: 2 },
  tabActive: { color: C.white },
  tabDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.red, marginTop: 3 },

  // Pages
  pageTitle: { color: C.white, fontSize: 24, fontWeight: "800", marginTop: 4 },
  pageSub: { color: C.grey, fontSize: 12, marginTop: 4, marginBottom: 14 },
  circleRow: {
    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.bgCard,
    borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.border, marginBottom: 10,
  },
  avatarSm: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarSmText: { color: C.white, fontWeight: "800" },
  circleName: { color: C.white, fontWeight: "700", fontSize: 14 },
  circlePhone: { color: C.grey, fontSize: 11, marginTop: 2 },
  onlineDotLg: { width: 10, height: 10, borderRadius: 5 },
  removeBtn: { padding: 6, paddingHorizontal: 10 },
  removeText: { color: C.grey, fontSize: 16 },
  addBox: { backgroundColor: C.bgCard, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.border, marginTop: 4 },
  addTitle: { color: C.white, fontWeight: "700", marginBottom: 10 },
  input: {
    backgroundColor: C.bgCard2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    color: C.white, fontSize: 14, borderWidth: 1, borderColor: C.border, marginBottom: 10,
  },
  inputLg: {
    backgroundColor: C.bgCard, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12,
    color: C.white, fontSize: 14, borderWidth: 1, borderColor: C.border, minHeight: 48, marginBottom: 12,
  },
  addBtn: { backgroundColor: C.white, borderRadius: 999, paddingVertical: 12, alignItems: "center", marginTop: 2 },
  addBtnText: { color: "#000", fontWeight: "800", fontSize: 14 },
  settingLabel: { color: C.white, fontWeight: "600", fontSize: 13, marginBottom: 8, marginTop: 4 },
  infoCard: { backgroundColor: C.bgCard, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, marginTop: 8 },
  infoTitle: { color: C.white, fontWeight: "700", marginBottom: 8 },
  infoText: { color: C.grey, fontSize: 12, lineHeight: 18 },

  emptyBox: { backgroundColor: C.bgCard, borderRadius: 16, padding: 24, alignItems: "center", borderWidth: 1, borderColor: C.border, marginTop: 8 },
  emptyEmoji: { fontSize: 28 },
  emptyTitle: { color: C.white, fontWeight: "700", marginTop: 8 },
  emptySub: { color: C.grey, fontSize: 12, textAlign: "center", marginTop: 4, lineHeight: 16 },
  historyCard: { backgroundColor: C.bgCard, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  historyHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  historyTargets: { color: C.redSoft, fontWeight: "800", fontSize: 13 },
  historyTime: { color: C.grey, fontSize: 11 },
  historyMsg: { color: C.white, fontSize: 13, marginTop: 8, lineHeight: 18 },
  historyMedical: { color: C.grey, fontSize: 11, marginTop: 6 },
  historyLink: { color: "#4DA3FF", fontSize: 11, marginTop: 8, textDecorationLine: "underline" },
  clearHistory: { alignItems: "center", padding: 12 },
  clearHistoryText: { color: C.grey, fontWeight: "600", fontSize: 12 },

  // Overlays
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,10,10,0.96)", alignItems: "center", justifyContent: "center",
    paddingHorizontal: 24,
  },
  countdownLabel: { color: C.grey, fontSize: 12, letterSpacing: 3, fontWeight: "700", textTransform: "uppercase" },
  countdownNumber: { color: C.white, fontSize: 96, fontWeight: "900", marginTop: 6 },
  countdownHint: { color: C.grey, fontSize: 12, marginTop: 10, textAlign: "center" },
  holdBarTrack: { width: 220, height: 8, backgroundColor: C.bgElevated, borderRadius: 999, marginTop: 16, overflow: "hidden", borderWidth: 1, borderColor: C.border },
  holdBarFill: { height: "100%", backgroundColor: C.red, borderRadius: 999 },
  cancelBtn: {
    marginTop: 28, backgroundColor: C.white, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 40,
  },
  cancelText: { color: "#000", fontWeight: "900", fontSize: 16, letterSpacing: 1 },

  // Sheets
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#1A1A1A", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 28, borderWidth: 1, borderColor: C.border },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.grey2, alignSelf: "center", marginBottom: 16 },
  sheetTitle: { color: C.white, fontSize: 20, fontWeight: "800" },
  sheetSub: { color: C.grey, fontSize: 12, marginTop: 6, lineHeight: 16 },
  sheetMsg: { color: C.white, fontSize: 14, marginTop: 10, fontStyle: "italic" },
  sheetLink: { color: "#4DA3FF", fontSize: 12, marginTop: 10, textDecorationLine: "underline" },
  sheetMedical: { color: C.grey, fontSize: 12, marginTop: 8 },
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 16 },
  sheetBtn: { flex: 1, backgroundColor: C.bgElevated, borderRadius: 12, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: C.border },
  sheetBtnGreen: { backgroundColor: "#1DB954", borderColor: "#1DB954" },
  sheetBtnText: { color: C.white, fontWeight: "700", fontSize: 12 },
  sheetHint: { color: C.grey2, fontSize: 11, textAlign: "center", marginTop: 10 },
  sheetClose: { backgroundColor: C.white, borderRadius: 999, paddingVertical: 12, alignItems: "center", marginTop: 14 },
  sheetCloseText: { color: "#000", fontWeight: "800" },

  pickRow: {
    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.bgCard2,
    borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border,
  },
  pickName: { color: C.white, fontWeight: "700" },
  pickPhone: { color: C.grey, fontSize: 11, marginTop: 2 },
  pickArrow: { color: C.grey, fontSize: 20 },
});
