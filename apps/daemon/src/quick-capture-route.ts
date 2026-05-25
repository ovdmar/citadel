import type express from "express";

// Standalone HTML page served outside /api/*. Designed to be opened in a
// Spotlight-style chromeless popup window by external shortcuts
// (scripts/mac-satellite/quick-capture.sh) and post via the existing block
// endpoint — no new daemon write surface, just a convenience UI.
//
// Inlined CSS + JS keep the page bundler-free; the daemon serves it as a
// single string, which means it works even when the cockpit's Vite/SPA bundle
// isn't built (helpful for the daemon-only dev loop). Voice capture reuses
// webkitSpeechRecognition / SpeechRecognition with the same 10s silence
// timeout as the cockpit hook.
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Citadel — Quick capture</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0b101a; color: #e5e9f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  .qc-frame { flex: 1 1 auto; display: flex; flex-direction: column; padding: 14px 16px;
    gap: 10px; }
  .qc-hint { font-size: 11px; color: #6f7c98; letter-spacing: 0.04em; text-transform: uppercase; }
  .qc-row { display: flex; gap: 8px; flex: 1 1 auto; min-height: 0; align-items: stretch; }
  textarea { flex: 1 1 auto; min-height: 0; resize: none; background: #11182a;
    color: inherit; border: 1px solid #1f2a44; border-radius: 6px; padding: 10px 12px;
    font-family: inherit; font-size: 14px; line-height: 1.4; outline: none; }
  textarea:focus { border-color: #4f8cff; }
  button.mic { width: 36px; height: 36px; flex: 0 0 auto; align-self: flex-end;
    background: #11182a; color: inherit; border: 1px solid #1f2a44; border-radius: 6px;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    font-size: 16px; }
  button.mic.on { background: #4f8cff; color: #fff; border-color: #4f8cff; }
  .qc-status { font-size: 12px; color: #97a3c1; min-height: 16px; }
  .qc-status.error { color: #f08097; }
  .qc-done { font-size: 13px; color: #aab8d8; padding: 12px; text-align: center; }
</style>
</head>
<body>
<div class="qc-frame">
  <div class="qc-hint">Quick capture · ⌘+Enter to save · Esc to close</div>
  <div class="qc-row">
    <textarea id="t" autofocus placeholder="Capture a thought…"></textarea>
    <button type="button" class="mic" id="m" aria-label="Voice capture" title="Voice capture">🎙</button>
  </div>
  <div class="qc-status" id="s" role="status" aria-live="polite"></div>
</div>
<script>
(function(){
  var t = document.getElementById('t');
  var s = document.getElementById('s');
  var m = document.getElementById('m');
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { m.style.display = 'none'; }
  var rec = null;
  var silenceTimer = null;
  function armSilence(){ if(silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(function(){ if (rec) try { rec.stop(); } catch(_){} }, 10000); }
  function startRec(){
    if (!SR) return;
    rec = new SR();
    rec.continuous = true; rec.interimResults = true;
    rec.onresult = function(e){ armSilence();
      var last = e.results[e.results.length - 1];
      if (!last || !last.isFinal) return;
      var piece = (last[0] && last[0].transcript || '').trim();
      if (!piece) return;
      t.value = t.value.trim().length === 0 ? piece : (t.value.trim() + ' ' + piece);
    };
    rec.onerror = function(ev){ s.className = 'qc-status error'; s.textContent = 'Voice error: ' + ev.error; stopRec(); };
    rec.onend = function(){ m.classList.remove('on'); if(silenceTimer) clearTimeout(silenceTimer); rec = null; };
    try { rec.start(); m.classList.add('on'); armSilence(); }
    catch(err){ s.className = 'qc-status error'; s.textContent = 'Voice error: ' + (err && err.message || err); rec = null; }
  }
  function stopRec(){ if(rec) try { rec.stop(); } catch(_){} }
  m.addEventListener('click', function(){ if (rec) stopRec(); else startRec(); });

  async function submit(){
    var text = t.value.trim();
    if (!text) { t.focus(); return; }
    s.className = 'qc-status'; s.textContent = 'Saving…';
    try {
      var res = await fetch('/api/scratchpad/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (err) {
      s.className = 'qc-status error';
      s.textContent = 'Save failed: ' + (err && err.message || err);
      t.focus(); return;
    }
    // Try to close (works in Chrome --app= popups). If still visible ~50ms later
    // we're probably in Safari or a regular tab — show a confirmation instead.
    window.close();
    setTimeout(function(){
      if (document.visibilityState === 'visible' && !document.hidden) {
        document.body.innerHTML = '<div class="qc-done">Captured. Press ⌘W to close.</div>';
      }
    }, 60);
  }

  t.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); window.close(); }
  });
})();
</script>
</body>
</html>
`;

export function registerQuickCaptureRoute({ app }: { app: express.Express }): void {
  app.get("/quick-capture", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("text/html; charset=utf-8").send(HTML);
  });
}
