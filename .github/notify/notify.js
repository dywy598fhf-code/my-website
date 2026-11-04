// Verschickt die Benachrichtigungen der Bibelstudium-App.
// Läuft alle 15 Minuten auf GitHub (siehe .github/workflows/benachrichtigungen.yml).
// Der geheime Firebase-Schlüssel kommt aus dem GitHub-Secret FIREBASE_SERVICE_ACCOUNT.
const APP = "https://dywy598fhf-code.github.io/my-website/bibelstudium/";
const TZ = "Europe/Zurich";
const MONDAY_HOUR = 9;     // Erinnerung „Am Montag“ um 9 Uhr
const DAYBEFORE_HOUR = 18; // Erinnerung „Am Tag vorher“ um 18 Uhr
const DEFAULT_CONFIG = { weekday: 4, time: "19:30", extras: [] };
const DAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/* ---------- Datum in Bern ---------- */
function bernNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(d).map(x => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { ymd, hour: +p.hour, wd: weekday(ymd) };
}
const toUTC = ymd => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const weekday = ymd => toUTC(ymd).getUTCDay();
const addDays = (ymd, n) => { const d = toUTC(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* Alle Treffen zwischen from und to (inklusive): wöchentliche plus weitere */
function meetingsBetween(config, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1))
    if (weekday(d) === config.weekday) out.push({ key: d, date: d, time: config.time, label: "" });
  for (const x of config.extras || [])
    if (x.date >= from && x.date <= to) out.push({ key: "x-" + x.id, date: x.date, time: x.time, label: x.label || "" });
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
const dayName = ymd => DAYS[weekday(ymd)];
const describe = m => `${m.label ? m.label + " am " : ""}${dayName(m.date)} um ${m.time} Uhr`;

/* ---------- Texte ---------- */
function reminderText(list, meets, when) {
  if (list.length === 1) {
    const m = list[0], cook = (meets[m.key] || {}).cook;
    return {
      title: when === "daybefore" ? `Morgen ist Bibelstudium` : `Diese Woche: Bibelstudium`,
      body: `${describe(m)}. ${cook ? cook + " kocht." : "Wer kocht?"} Bist du dabei?`
    };
  }
  return {
    title: when === "daybefore" ? "Morgen ist Bibelstudium" : "Diese Woche: Bibelstudium",
    body: list.map(describe).join(" · ") + ". Bist du dabei?"
  };
}
function prayerText(p) {
  return { title: "Neues Gebetsanliegen", body: `${p.by} betet für ${p.name}${p.text ? ": " + p.text : ""}` };
}

/* ---------- Eine Gruppe abarbeiten ---------- */
async function runGroup(db, send, ref, now) {
  const get = async (...path) => (await ref.collection(path[0]).doc(path[1]).get()).data() || {};
  const config = { ...DEFAULT_CONFIG, ...(await get("meta", "config")) };
  const stateRef = ref.collection("meta").doc("notify");
  const state = (await stateRef.get()).data() || {};
  const devices = (await ref.collection("devices").get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.token);
  const update = {};
  const jobs = [];

  // Neue Gebetsanliegen
  if (state.prayerT === undefined) update.prayerT = Date.now(); // beim allerersten Mal nichts Altes verschicken
  else {
    const fresh = (await ref.collection("prayers").where("t", ">", state.prayerT).get()).docs.map(d => d.data());
    if (fresh.length) {
      update.prayerT = Math.max(...fresh.map(p => p.t));
      for (const p of fresh) for (const d of devices)
        if (d.prayers && d.name !== p.by) jobs.push({ d, msg: { ...prayerText(p), url: APP + "#gebet" } });
    }
  }

  // Erinnerungen ans Treffen
  const needMeets = [];
  if (now.wd === 1 && now.hour >= MONDAY_HOUR && state.monday !== now.ymd) {
    update.monday = now.ymd;
    const list = meetingsBetween(config, now.ymd, addDays(now.ymd, 6));
    if (list.length) needMeets.push(["monday", list]);
  }
  if (now.hour >= DAYBEFORE_HOUR && state.daybefore !== now.ymd) {
    update.daybefore = now.ymd;
    const t = addDays(now.ymd, 1), list = meetingsBetween(config, t, t);
    if (list.length) needMeets.push(["daybefore", list]);
  }
  if (needMeets.length) {
    const meets = {};
    (await ref.collection("meetings").get()).docs.forEach(d => { meets[d.id] = d.data(); });
    for (const [when, list] of needMeets) {
      const text = reminderText(list, meets, when);
      for (const d of devices) if (d.remind === when) jobs.push({ d, msg: { ...text, url: APP + "#treffen", tag: "treffen" } });
    }
  }

  if (jobs.length) await send(jobs, ref);
  if (Object.keys(update).length) await stateRef.set(update, { merge: true });
  return jobs.length;
}

/* ---------- Start ---------- */
async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.log("FIREBASE_SERVICE_ACCOUNT fehlt noch – nichts zu tun."); return; }
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore(), fcm = admin.messaging();
  const send = async (jobs, ref) => {
    const res = await fcm.sendEach(jobs.map(({ d, msg }) => ({
      token: d.token,
      data: Object.fromEntries(Object.entries(msg).map(([k, v]) => [k, String(v)])),
      webpush: { headers: { Urgency: "high", TTL: "86400" } }
    })));
    // Abgemeldete Handys entfernen
    await Promise.all(res.responses.map((r, i) => {
      const c = r.error && r.error.code;
      if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token")
        return ref.collection("devices").doc(jobs[i].d.id).delete();
    }));
    console.log(`${ref.id}: ${res.successCount} gesendet, ${res.failureCount} fehlgeschlagen`);
  };
  const now = bernNow();
  for (const ref of await db.collection("groups").listDocuments()) {
    try { await runGroup(db, send, ref, now); } catch (e) { console.error(ref.id, e); process.exitCode = 1; }
  }
}

if (require.main === module) main();
module.exports = { bernNow, meetingsBetween, addDays, reminderText, prayerText, runGroup };
