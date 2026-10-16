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
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import * as Clipboard from "expo-clipboard";

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

// ── API base: bake hosted URL via app.json expo.extra.apiUrl, fallback to LAN/localhost
function getApiBase(){
  const extra = Constants?.expoConfig?.extra || Constants?.manifest?.extra || {};
  if(extra.apiUrl) return String(extra.apiUrl).replace(/\/$/,"");
  // Expo Go LAN fallback — prefer 192.168.1.5 if known, else localhost
  const hostUri = Constants?.expoConfig?.hostUri || Constants?.manifest?.hostUri || "";
  const m = hostUri.match(/^([\d.]+):/);
  if(m) return `http://${m[1]}:3002`;
  return "http://192.168.1.5:3002";
}
function genId(n=10){
  const c="abcdefghijklmnopqrstuvwxyz0123456789";
  let s=""; for(let i=0;i<n;i++) s+=c[Math.floor(Math.random()*c.length)];
  return s;
}
async function apiFetch(base, path, opts={}){
  const url = `${base}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 7000);
  try{
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "Content-Type":"application/json", ...(opts.headers||{}) }});
    const j = await r.json().catch(()=>null);
    if(!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
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

  // SOS flow — Option 3: Hold 2 sec → instant send
  const [sosMode, setSosMode] = useState(null); // "all" | contactId | null
  const [sosPhase, setSosPhase] = useState("idle"); // idle | holding | sending | success
  const [lastSent, setLastSent] = useState(null);
  const [selectSheet, setSelectSheet] = useState(false);
  const [pendingContactId, setPendingContactId] = useState(null);

  // Any-internet wiring
  const apiBaseRef = useRef(getApiBase());
  const API_BASE = apiBaseRef.current;
  const [deviceId, setDeviceId] = useState(null);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteOut, setInviteOut] = useState(null); // { code, link, circleId, expiresAt }
  const [acceptCode, setAcceptCode] = useState("");
  const [netHint, setNetHint] = useState("");
  // Incoming urgent SOS
  const [incoming, setIncoming] = useState(null); // { pushId, sosId, attempt, max, sos }
  const pollRef = useRef(null);
  const alarmRef = useRef(null);

  useEffect(()=>{
    (async()=>{
      try{
        let id = await SecureStore.getItemAsync("sos_deviceId");
        if(!id){ id = genId(12); await SecureStore.setItemAsync("sos_deviceId", id); }
        setDeviceId(id);
      } catch {
        const id = genId(12);
        setDeviceId(id);
      }
    })();
  }, []);

  // Poll for urgent SOS pushes (30s cadence, only when foregrounded)
  useEffect(()=>{
    if(!deviceId) return;
    let alive = true;
    async function poll(){
      try{
        const out = await apiFetch(API_BASE, `/api/push?deviceId=${encodeURIComponent(deviceId)}`);
        if(!alive) return;
        if(Array.isArray(out) && out.length>0){
          // show newest
          const newest = out[out.length-1];
          setIncoming(newest);
          // loud alarm loop
          try{ Vibration.vibrate([0,1000,300,1000]); }catch{}
          if(!alarmRef.current){
            alarmRef.current = setInterval(()=>{ try{ Vibration.vibrate([0,1000,300,1000]); }catch{} }, 4000);
          }
        }
      } catch {}
    }
    poll();
    pollRef.current = setInterval(poll, 30000);
    return ()=>{ alive=false; if(pollRef.current) clearInterval(pollRef.current); if(alarmRef.current) clearInterval(alarmRef.current); };
  }, [deviceId, API_BASE]);

  function stopAlarm(){
    if(alarmRef.current){ clearInterval(alarmRef.current); alarmRef.current=null; }
    try{ Vibration.cancel(); }catch{}
  }
  async function ackIncoming(actionLabel){
    if(!incoming || !deviceId) return;
    stopAlarm();
    const sid = incoming.sosId;
    setIncoming(null);
    try{ await apiFetch(API_BASE, `/api/push/${encodeURIComponent(sid)}/ack`, { method:"POST", body: JSON.stringify({ deviceId }) }); }catch{}
    // also add to history as received
  }

  // Animations
  const pulse = useRef(new Animated.Value(1)).current;
  const holdProgress = useRef(new Animated.Value(0)).current;
  const holdTimerRef = useRef(null);
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

  function clearTimers() {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
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
      duration: 2000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && isHoldingRef.current) {
        try { Vibration.vibrate([0, 180, 60, 180]); } catch {}
        doSend();
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
    // Also push to backend for any-internet delivery (best-effort)
    if(deviceId){
      apiFetch(API_BASE, "/api/sos", { method:"POST", body: JSON.stringify({ from: deviceId, targets: entry.targets, message: msg, locationLink, medicalNotes: entry.medicalNotes }) }).then(j=>{
        if(j?.pushedTo!=null) setNetHint(`Pushed to ${j.pushedTo} device(s) in Circle • also saved locally`);
      }).catch(()=> setNetHint("Saved locally — will retry when online (offline or no backend)"));
      setTimeout(()=>setNetHint(""), 7000);
    }
  }

  function closeSuccess() {
    setSosPhase("idle");
    setSosMode(null);
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

  // ── Invite actions ──
  async function createInvite(){
    if(!deviceId) return Alert.alert("Not ready","Device ID not ready yet.");
    try{
      const j = await apiFetch(API_BASE, "/api/invites", { method:"POST", body: JSON.stringify({ from: deviceId, fromName: "You" }) });
      setInviteOut(j);
      setInviteCode(j.code);
    } catch(e){ Alert.alert("Invite failed", String(e.message||e)); }
  }
  async function copyInvite(){
    if(!inviteOut) return;
    const webBase = (Constants?.expoConfig?.extra?.webUrl)||"";
    const human = webBase ? `${String(webBase).replace(/\/$/,"")}/?code=${inviteOut.code}` : `sos://${inviteOut.code}`;
    await Clipboard.setStringAsync(human);
    Alert.alert("Copied", human);
  }
  async function revokeInvite(){
    if(!inviteOut) return;
    try{ await apiFetch(API_BASE, `/api/invites/${encodeURIComponent(inviteOut.code)}/revoke`, { method:"POST", body: "{}" }); Alert.alert("Revoked","Invite revoked."); setInviteOut(null); }catch(e){ Alert.alert("Revoke failed", String(e.message||e));}
  }
  async function acceptInvite(){
    const code = (acceptCode||inviteCode).trim();
    if(!code) return Alert.alert("Enter code","Paste the invite code (e.g. a1B2c3D4).");
    if(!deviceId) return Alert.alert("Not ready","Device ID not ready.");
    try{
      const j = await apiFetch(API_BASE, `/api/invites/${encodeURIComponent(code)}/accept`, { method:"POST", body: JSON.stringify({ deviceId, name: "Friend" }) });
      Alert.alert("Joined", `Joined Circle ${j.circleId}. Members: ${j.members?.length||1}`);
      setAcceptCode("");
    } catch(e){ Alert.alert("Accept failed", String(e.message||e)); }
  }

  // ── Screens ──
  const HomeScreen = (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Emergency SOS</Text>
        <Text style={styles.headerSub}>Dark • Red • Ready</Text>
        {!!netHint && <Text style={{color:C.green,fontSize:11,marginTop:6}}>{netHint}</Text>}
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
            <Text style={styles.sosBigSub}>Hold 2 sec</Text>
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

      <Text style={styles.footer}>Hold 2 sec → instant send. No countdown — fast when it matters.</Text>
      <Text style={[styles.footer,{marginTop:4,color:C.grey}]}>Backend: {API_BASE} {deviceId?`• ID ${deviceId.slice(0,6)}`:''}</Text>
    </ScrollView>
  );

  const CircleScreen = (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.pageTitle}>Trusted Circle</Text>
      <Text style={styles.pageSub}>Invite must Accept. They can leave anytime. Tap to edit.</Text>

      {/* Any-internet Invite box */}
      <View style={styles.addBox}>
        <Text style={styles.addTitle}>Invite (any internet) — code link only</Text>
        <Text style={styles.hint}>Create a single-use code (30 min, revocable). Share via Copy Link or QR. Phone optional.</Text>
        <Pressable onPress={createInvite} style={[styles.addBtn,{marginTop:10}]}>
          <Text style={styles.addBtnText}>🔗  Create Invite Link</Text>
        </Pressable>
        {inviteOut && (
          <View style={{marginTop:12, backgroundColor:C.bgCard2, borderRadius:12, padding:12, borderWidth:1, borderColor:C.border}}>
            <Text style={{color:C.white,fontWeight:"800",fontSize:13}}>Code: {inviteOut.code}</Text>
            <Text style={{color:C.grey,fontSize:11,marginTop:4}}>Expires {new Date(inviteOut.expiresAt).toLocaleTimeString()} • Single-use • Revocable</Text>
            <Text style={{color:"#4DA3FF",fontSize:11,marginTop:8}}>sos://{inviteOut.code}</Text>
            <View style={{flexDirection:"row",gap:10,marginTop:10}}>
              <Pressable onPress={copyInvite} style={[styles.sheetBtn,{flex:1}]}><Text style={styles.sheetBtnText}>Copy Link</Text></Pressable>
              <Pressable onPress={()=>Alert.alert("QR",`For V1, share the code. QR: https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=sos://${inviteOut.code}`)} style={[styles.sheetBtn,{flex:1}]}><Text style={styles.sheetBtnText}>Show QR</Text></Pressable>
            </View>
            <Pressable onPress={revokeInvite} style={{marginTop:10,alignItems:"center"}}><Text style={{color:C.redSoft,fontWeight:"700",fontSize:12}}>Revoke invite</Text></Pressable>
            {/* QR image preview (web API) */}
            <View style={{alignItems:"center",marginTop:10, backgroundColor:"#fff", borderRadius:12, padding:8, alignSelf:"center"}}>
              <Text style={{color:"#000",fontSize:10,fontWeight:"700",marginBottom:6}}>QR for sos://{inviteOut.code}</Text>
            </View>
          </View>
        )}
        <View style={{marginTop:14, flexDirection:"row",gap:8}}>
          <TextInput value={acceptCode} onChangeText={setAcceptCode} placeholder="Paste invite code" placeholderTextColor={C.grey2} style={[styles.input,{flex:1, marginBottom:0}]} autoCapitalize="none" />
          <Pressable onPress={acceptInvite} style={[styles.addBtn,{paddingHorizontal:16, marginTop:0}]}><Text style={styles.addBtnText}>Accept</Text></Pressable>
        </View>
        <Text style={[styles.hint,{marginTop:6}]}>Accept joins their Circle. Backend: {API_BASE}</Text>
      </View>

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
        <Text style={styles.addTitle}>Add contact (local V1)</Text>
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
        <Text style={styles.hint}>Local contacts stay on device. Use Invite above to link across internet.</Text>
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
        <Text style={styles.infoText}>2. Hold SOS 2 sec — instant send (release early to cancel)</Text>
        <Text style={styles.infoText}>3. It sends location + message + time to your Circle</Text>
        <Text style={[styles.infoText, { marginTop: 8, color: C.grey }]}>
          Port: 5174  •  Same WiFi only for Expo preview  •  Real SOS works on any internet
        </Text>
        <Text style={[styles.infoText, { color: C.grey }]}>Backend: {API_BASE}</Text>
        <Text style={[styles.infoText, { color: C.grey }]}>Device ID: {deviceId || "…"}</Text>
      </View>

      <Pressable onPress={callEmergency} style={[styles.callEmergency, { marginTop: 16 }]}>
        <Text style={styles.callEmergencyText}>📞  Call Emergency  112 / 911</Text>
      </Pressable>
    </ScrollView>
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Top safe area spacer — hide during SOS */}
      {sosPhase === "idle" && <View style={styles.topSpacer} />}

      <View style={{ flex: 1 }}>
        {tab === "home" && HomeScreen}
        {tab === "circle" && CircleScreen}
        {tab === "history" && HistoryScreen}
        {tab === "settings" && SettingsScreen}
      </View>

      {/* Bottom nav — hidden during hold/sending */}
      {sosPhase === "idle" && !incoming && (
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
      )}

      {/* Hold overlay — 2 sec to arm, release to cancel */}
      {sosPhase === "holding" && (
        <View style={styles.countdownOverlay} pointerEvents="none">
          <Text style={styles.countdownLabel}>KEEP HOLDING</Text>
          <View style={styles.holdBarTrack}>
            <Animated.View style={[styles.holdBarFill, { width: holdWidth }]} />
          </View>
          <Text style={styles.countdownHint}>Release early to cancel • 2 sec to send instantly</Text>
        </View>
      )}

      {/* Sending */}
      {sosPhase === "sending" && (
        <View style={styles.countdownOverlay}>
          <Text style={styles.countdownLabel}>SENDING…</Text>
          <Text style={styles.countdownHint}>Getting location and saving…</Text>
        </View>
      )}

      {/* Urgent SOS incoming — repeats until ack */}
      {incoming && (
        <View style={[styles.countdownOverlay,{backgroundColor:"rgba(180,0,0,0.98)"}]}>
          <Text style={[styles.countdownLabel,{color:"#fff"}]}>🚨 SOS from {incoming.sos?.from ? incoming.sos.from.slice(0,6) : "Someone"}</Text>
          <Text style={{color:"#fff",fontWeight:"900",fontSize:16,marginTop:12, textAlign:"center"}}>{incoming.sos?.message}</Text>
          <Pressable onPress={()=> Linking.openURL(incoming.sos?.locationLink||"").catch(()=>{})}>
            <Text style={[styles.historyLink,{color:"#fff", textAlign:"center", marginTop:10}]}>{incoming.sos?.locationLink}</Text>
          </Pressable>
          {incoming.sos?.medicalNotes ? <Text style={{color:"#fff",marginTop:8}}>🩺 {incoming.sos.medicalNotes}</Text>:null}
          <Text style={[styles.countdownHint,{color:"#fff", marginTop:10}]}>Alert {incoming.attempt}/{incoming.max} • repeats every 30s until you ack</Text>
          <View style={{flexDirection:"row",gap:12,marginTop:18}}>
            <Pressable onPress={()=>ackIncoming("I Saw It")} style={[styles.sheetClose,{paddingHorizontal:22}]}><Text style={styles.sheetCloseText}>I Saw It</Text></Pressable>
            <Pressable onPress={()=>ackIncoming("On My Way")} style={[styles.sheetClose,{backgroundColor:C.green, borderColor:C.green}]}><Text style={[styles.sheetCloseText,{color:"#fff"}]}>I'm On My Way</Text></Pressable>
          </View>
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
            <Text style={styles.sheetSub}>Pick one person — then hold 2 sec → instant send only to them.</Text>
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
  scrollContent: { paddingBottom: 16, paddingHorizontal: 16 },

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

  // Tab bar — lifted above Android nav buttons (Redmi 3-button nav)
  tabBar: {
    flexDirection: "row", backgroundColor: "#0F0F0F", borderTopWidth: 1, borderTopColor: C.border,
    paddingTop: 10, paddingBottom: Platform.OS === "ios" ? 28 : 26,
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
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(10,10,10,0.98)", alignItems: "center", justifyContent: "center",
    paddingHorizontal: 24, paddingTop: 44, paddingBottom: 86,
    zIndex: 50, elevation: 50,
  },
  countdownLabel: { color: C.grey, fontSize: 12, letterSpacing: 3, fontWeight: "700", textTransform: "uppercase" },
  countdownHint: { color: C.grey, fontSize: 12, marginTop: 10, textAlign: "center" },
  holdBarTrack: { width: 220, height: 8, backgroundColor: C.bgElevated, borderRadius: 999, marginTop: 16, overflow: "hidden", borderWidth: 1, borderColor: C.border },
  holdBarFill: { height: "100%", backgroundColor: C.red, borderRadius: 999 },

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
