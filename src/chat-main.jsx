import { Component } from "react";
import { createRoot } from "react-dom/client";
import { LiveChat } from "./lumen.jsx";

// Error boundary around the whole app. Without it, a throw during the FIRST render
// of LiveChat means React never commits, so it never replaces #root's children —
// the client is stranded on chat.html's #boot splash ("Loading your session…")
// forever, which reads as a dead/blank page. The boundary itself renders
// successfully, so React commits its fallback and the splash is cleared; the client
// gets an honest message and a reload, and the error is logged for telemetry.
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err, info) { try { console.error("LiveChat crashed during render", err, info); } catch {} }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:"32px 24px",textAlign:"center",background:"#fff",fontFamily:"'Inter',Arial,sans-serif"}}>
        <div style={{width:64,height:64,borderRadius:18,background:"#7E48EC",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 24px rgba(126,72,236,.25)"}}>
          <svg width="38" height="38" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#7E48EC"/><path d="M16 6V26M6 16H26M9 9L23 23M23 9L9 23" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"/><circle cx="16" cy="16" r="4" fill="#fff"/></svg>
        </div>
        <div style={{color:"#1e293b",fontSize:16,fontWeight:600}}>This page didn't load correctly</div>
        <div style={{color:"#64748b",fontSize:14,maxWidth:360,lineHeight:1.5}}>Please reload to try again. If it keeps happening, your Lumen contact can help you pick up where you left off.</div>
        <button onClick={() => location.reload()} style={{marginTop:4,padding:"11px 22px",borderRadius:10,border:"none",background:"#7E48EC",color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer"}}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary><LiveChat /></ErrorBoundary>
);
