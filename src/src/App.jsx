import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Settings, Upload, QrCode, User, Clock, Trash2, Camera, Play, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// Helper: format ms to mm:ss
const fmt = (ms) => {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
};

// Local storage keys
const LS_KEYS = {
  settings: "dhp_settings_v1",
  logs: "dhp_logs_v1",
  roster: "dhp_roster_v1",
  session: "dhp_active_session_v1",
};

export default function App() {
  const [settings, setSettings] = useState(() => {
    const def = { restroomName: "Main Restroom", requireQR: true, allowManualID: true };
    try { return { ...def, ...(JSON.parse(localStorage.getItem(LS_KEYS.settings)) || {}) }; } catch { return def; }
  });

  const [logs, setLogs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEYS.logs)) || []; } catch { return []; }
  });

  const [roster, setRoster] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEYS.roster)) || {}; } catch { return {}; }
  });

  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEYS.session)) || null; } catch { return null; }
  });

  const [now, setNow] = useState(Date.now());
  const [showSettings, setShowSettings] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [qrPurpose, setQrPurpose] = useState(/** @type {"start"|"end"|null} */(null));

  // Ticker for timer
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Persist
  useEffect(() => localStorage.setItem(LS_KEYS.settings, JSON.stringify(settings)), [settings]);
  useEffect(() => localStorage.setItem(LS_KEYS.logs, JSON.stringify(logs)), [logs]);
  useEffect(() => localStorage.setItem(LS_KEYS.roster, JSON.stringify(roster)), [roster]);
  useEffect(() => localStorage.setItem(LS_KEYS.session, JSON.stringify(session)), [session]);

  const duration = useMemo(() => session ? (now - new Date(session.start).getTime()) : 0, [now, session]);

  // ID entry field (works with keyboard-wedge barcode scanners)
  const idRef = useRef(null);
  const [enteredID, setEnteredID] = useState("");

  const resolveName = (id) => roster[id]?.name || "Unknown";

  // Start session
  const startSession = ({ id, qrValue }) => {
    if (session) return; // already occupied
    if (settings.requireQR && !qrValue) return;
    const name = resolveName(id);
    const s = { id, name, qrValue: qrValue || null, start: new Date().toISOString() };
    setSession(s);
  };

  // End session
  const endSession = ({ id, qrValue }) => {
    if (!session) return; // nothing to end
    if (String(id) !== String(session.id)) {
      alert("ID does not match the active pass.");
      return;
    }
    if (settings.requireQR && qrValue && session.qrValue && qrValue !== session.qrValue) {
      alert("This QR doesn't match the one used to start the pass.");
      return;
    }
    const end = new Date();
    const start = new Date(session.start);
    const ms = end.getTime() - start.getTime();
    const entry = {
      id: session.id,
      name: session.name,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      durationMs: ms,
      restroom: settings.restroomName,
    };
    setLogs((prev) => [entry, ...prev]);
    setSession(null);
    setEnteredID("");
  };

  // CSV export
  const csv = useMemo(() => {
    const header = ["Restroom","ID","Name","Start","End","Duration (mm:ss)"];
    const rows = logs.map(l => [
      l.restroom,
      l.id,
      l.name,
      new Date(l.startISO).toLocaleString(),
      new Date(l.endISO).toLocaleString(),
      fmt(l.durationMs),
    ]);
    return [header, ...rows].map(r => r.map(x => `"${String(x).replaceAll('"','""')}"`).join(",")).join("\n");
  }, [logs]);

  const downloadCSV = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hallpass_logs_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Roster import/export (CSV with columns: id,name)
  const handleRosterImport = async (file) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines.shift();
    const cols = header.split(",").map(s => s.trim().toLowerCase());
    const idIdx = cols.indexOf("id");
    const nameIdx = cols.indexOf("name");
    if (idIdx === -1 || nameIdx === -1) {
      alert("CSV must have 'id' and 'name' columns.");
      return;
    }
    const out = {};
    for (const line of lines) {
      const parts = line.split(",");
      const id = parts[idIdx]?.trim();
      const name = parts[nameIdx]?.trim();
      if (id) out[id] = { name };
    }
    setRoster(out);
  };

  const exportRosterCSV = () => {
    const header = "id,name\n";
    const body = Object.entries(roster).map(([id, v]) => `${id},${v.name}`).join("\n");
    const blob = new Blob([header + body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "roster_template.csv"; a.click(); URL.revokeObjectURL(url);
  };

  // QR Scanning (camera) — lazy-load html5-qrcode only when needed
  const scannerDivRef = useRef(null);
  useEffect(() => {
    let scannerInstance = null;
    let cleanup = () => {};
    if (showQR && qrPurpose) {
      (async () => {
        try {
          const mod = await import("html5-qrcode");
          const { Html5QrcodeScanner } = mod;
          const divId = "qr-scanner-root";
          if (scannerDivRef.current) scannerDivRef.current.innerHTML = `<div id="${divId}"></div>`;
          const scanner = new Html5QrcodeScanner(divId, { fps: 10, qrbox: 250 }, false);
          scannerInstance = scanner;
          scanner.render((decodedText) => {
            // On success
            if (qrPurpose === "start") {
              // Need ID too — if already typed, start
              const id = (idRef.current?.value || enteredID).trim();
              if (!id) {
                alert("Enter or scan Student ID first, then scan the restroom QR.");
              } else {
                startSession({ id, qrValue: decodedText });
                setShowQR(false); setQrPurpose(null);
              }
            } else if (qrPurpose === "end") {
              const id = (idRef.current?.value || enteredID).trim();
              if (!id) {
                alert("Enter or scan the same Student ID to end the pass, then scan the restroom QR.");
              } else {
                endSession({ id, qrValue: decodedText });
                setShowQR(false); setQrPurpose(null);
              }
            }
          }, (errorMessage) => {
            // ignore scan errors
          });
          cleanup = () => scanner.clear();
        } catch (e) {
          console.error("QR module failed", e);
          if (scannerDivRef.current) scannerDivRef.current.textContent = "Camera not available or blocked.";
        }
      })();
    }
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showQR, qrPurpose]);

  const bgClass = session ? "bg-red-600" : "bg-green-600";
  const statusText = session ? `OCCUPIED • ${fmt(duration)}` : "AVAILABLE";

  return (
    <div className={`min-h-screen ${bgClass} text-white transition-colors duration-300`}> 
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl md:text-4xl font-bold">Digital Hall Pass</h1>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowSettings(true)}><Settings className="w-4 h-4 mr-2"/>Settings</Button>
            <Button variant="secondary" onClick={downloadCSV}><Download className="w-4 h-4 mr-2"/>Export Logs</Button>
          </div>
        </div>

        {/* Status Card */}
        <Card className="bg-white/10 backdrop-blur border-white/20 text-white shadow-xl">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="text-xl md:text-2xl">{settings.restroomName}</span>
              <span className="text-lg md:text-2xl font-mono flex items-center gap-2"><Clock className="w-5 h-5"/>{statusText}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!session ? (
              <div className="grid md:grid-cols-3 gap-4 items-end">
                <div className="md:col-span-2">
                  <Label className="text-white">Scan or type Student ID</Label>
                  <Input
                    ref={idRef}
                    value={enteredID}
                    onChange={(e) => setEnteredID(e.target.value)}
                    placeholder="Focus here, then scan the ID barcode or type manually"
                    className="bg-white text-black"
                  />
                </div>
                <div className="flex gap-2">
                  <Button className="w-full" onClick={() => {
                    const id = (idRef.current?.value || enteredID).trim();
                    if (!id) { alert("Enter or scan Student ID first."); return; }
                    if (settings.requireQR) { setQrPurpose("start"); setShowQR(true); }
                    else { startSession({ id, qrValue: null }); }
                  }}>
                    <Play className="w-4 h-4 mr-2"/> Start Pass
                  </Button>
                  {settings.requireQR && (
                    <Button variant="secondary" className="w-12" onClick={() => { setQrPurpose("start"); setShowQR(true); }} title="Scan restroom QR">
                      <QrCode className="w-5 h-5"/>
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid md:grid-cols-3 gap-4 items-center">
                <div className="md:col-span-2 space-y-2">
                  <div className="flex items-center gap-2 text-lg md:text-2xl"><User className="w-5 h-5"/> <span>{session.name}</span> <span className="opacity-80">(ID {session.id})</span></div>
                  <div className="text-sm opacity-90">Started: {new Date(session.start).toLocaleString()}</div>
                </div>
                <div className="flex gap-2">
                  <Input
                    ref={idRef}
                    value={enteredID}
                    onChange={(e) => setEnteredID(e.target.value)}
                    placeholder="Enter same Student ID to end"
                    className="bg-white text-black"
                  />
                  <Button variant="destructive" onClick={() => {
                    const id = (idRef.current?.value || enteredID).trim();
                    if (!id) { alert("Enter or scan the same Student ID to end the pass."); return; }
                    if (settings.requireQR) { setQrPurpose("end"); setShowQR(true); }
                    else { endSession({ id, qrValue: null }); }
                  }}>
                    <StopCircle className="w-4 h-4 mr-2"/> End Pass
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Logs */}
        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-2">Usage Log</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm bg-white/10 border border-white/20">
              <thead className="bg-white/20">
                <tr>
                  <th className="p-2 text-left">Date</th>
                  <th className="p-2 text-left">Restroom</th>
                  <th className="p-2 text-left">ID</th>
                  <th className="p-2 text-left">Name</th>
                  <th className="p-2 text-left">Start</th>
                  <th className="p-2 text-left">End</th>
                  <th className="p-2 text-left">Duration</th>
                  <th className="p-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr><td className="p-3" colSpan={8}>No logs yet.</td></tr>
                )}
                {logs.map((l, i) => (
                  <tr key={i} className="border-t border-white/10">
                    <td className="p-2">{new Date(l.startISO).toLocaleDateString()}</td>
                    <td className="p-2">{l.restroom}</td>
                    <td className="p-2 font-mono">{l.id}</td>
                    <td className="p-2">{l.name}</td>
                    <td className="p-2">{new Date(l.startISO).toLocaleTimeString()}</td>
                    <td className="p-2">{new Date(l.endISO).toLocaleTimeString()}</td>
                    <td className="p-2">{fmt(l.durationMs)}</td>
                    <td className="p-2">
                      <Button size="sm" variant="ghost" onClick={() => setLogs(prev => prev.filter((_, idx) => idx !== i))}><Trash2 className="w-4 h-4"/></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Settings Panel */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
            >
              <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="w-full max-w-2xl bg-white text-black rounded-2xl p-6 shadow-2xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-semibold">Settings</h3>
                  <Button variant="ghost" onClick={() => setShowSettings(false)}>Close</Button>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Restroom name</Label>
                    <Input value={settings.restroomName} onChange={(e) => setSettings(s => ({ ...s, restroomName: e.target.value }))} />
                  </div>

                  <div className="flex items-center justify-between border rounded-xl p-3">
                    <div>
                      <Label>Require QR scan to start/end</Label>
                      <div className="text-xs text-gray-600">Students must scan the posted restroom QR.</div>
                    </div>
                    <Switch checked={settings.requireQR} onCheckedChange={(v) => setSettings(s => ({ ...s, requireQR: Boolean(v) }))} />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label>Roster (CSV)</Label>
                    <div className="flex gap-2 flex-wrap">
                      <input id="rosterFile" type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files && handleRosterImport(e.target.files[0])} />
                      <Button onClick={() => document.getElementById("rosterFile").click()}><Upload className="w-4 h-4 mr-2"/>Import CSV</Button>
                      <Button variant="secondary" onClick={exportRosterCSV}><Download className="w-4 h-4 mr-2"/>Template / Export</Button>
                      <Button variant="destructive" onClick={() => setRoster({})}><Trash2 className="w-4 h-4 mr-2"/>Clear Roster</Button>
                    </div>
                    <div className="text-xs text-gray-600">CSV must include columns: <code>id</code>, <code>name</code>. When a student scans their ID, their name will appear on screen and in the log.</div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* QR Modal */}
        <AnimatePresence>
          {showQR && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
              <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} className="bg-white rounded-2xl p-4 w-full max-w-md text-black">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold flex items-center gap-2"><Camera className="w-4 h-4"/> {qrPurpose === "start" ? "Scan Restroom QR to Start" : "Scan Restroom QR to End"}</div>
                  <Button variant="ghost" onClick={() => { setShowQR(false); setQrPurpose(null); }}>Close</Button>
                </div>
                <div ref={scannerDivRef} className="rounded-xl overflow-hidden bg-black">
                  {/* html5-qrcode injects here */}
                </div>
                <div className="text-xs text-gray-600 mt-2">If camera access is blocked, allow camera permissions in your browser settings.</div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer helper */}
        <div className="mt-10 text-sm opacity-90">
          Tip: Most barcode scanners act like a keyboard. Click into the ID box, then scan the student card.
        </div>
      </div>
    </div>
  );
}