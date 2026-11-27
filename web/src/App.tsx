import { useEffect, useLayoutEffect } from 'react';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { Gate } from './components/Gate';
import { ConnectAppsModal } from './components/modals/ConnectAppsModal';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { TasksView } from './components/config/TasksView';
import { useConfigUI } from './configStore';
import { NARROW, OVERLAY_DETAILS, useKeyboardInset, useMediaQuery } from './lib/responsive';

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const view = useConfigUI((s) => s.view);
  const navOpen = useStore((s) => s.navOpen);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const overlayDetails = useMediaQuery(OVERLAY_DETAILS);
  useKeyboardInset();

  // When the window shrinks below the three-column width the details panel would cover the chat: close it
  // (set straight on the store, so the saved desktop preference is left alone).
  useLayoutEffect(() => { if (overlayDetails) useStore.setState({ detailsOpen: false }); }, [overlayDetails]);
  // Narrow screens: going to a bot or to Tasks puts the sidebar drawer away.
  useEffect(() => { useStore.setState({ navOpen: false }); }, [selectedBotId, view]);

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'corbot-connected') return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts, with Ctrl or Command: K search, B sidebar, Shift+, details, comma settings. Shown to the person by lib/keys.ts.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); st.set(window.matchMedia(NARROW).matches ? { navOpen: !st.navOpen } : { sidebarCollapsed: !st.sidebarCollapsed }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className={`app${collapsed ? ' is-sidebar-collapsed' : ''}${detailsOpen && hasBot && view === 'chat' ? ' has-details' : ''}${navOpen ? ' is-nav-open' : ''}`}>
      <Sidebar />
      {/* Backdrops for the drawers; responsive.css shows them only at the widths where the sidebar or the details panel floats. */}
      {navOpen && <div className="app__backdrop app__backdrop--nav" onClick={() => useStore.setState({ navOpen: false })} aria-hidden />}
      {view === 'tasks' ? <TasksView /> : <ChatView />}
      {detailsOpen && hasBot && view === 'chat' && <div className="app__backdrop app__backdrop--details" onClick={() => useStore.getState().set({ detailsOpen: false })} aria-hidden />}
      {detailsOpen && hasBot && view === 'chat' && <DetailsPanel />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  const gate = useStore((s) => s.gate);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  if (!authChecked) return <div className="boot" />;
  if (!gate) return <Gate />;
  return user ? <Shell /> : <SignIn />;
}
