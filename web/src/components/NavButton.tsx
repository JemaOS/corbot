import { useStore } from '../store';
import { useT } from '../i18n';
import { Icon } from './Icon';

/** Opens the sidebar drawer. responsive.css shows it only on narrow screens, where the sidebar is not on screen. */
export function NavButton() {
  const t = useT();
  const navOpen = useStore((s) => s.navOpen);
  return (
    <button type="button" className="icon-btn icon-btn--bordered nav-btn" onClick={() => useStore.setState({ navOpen: true })} aria-label={t('Open menu')} title={t('Open menu')} aria-expanded={navOpen}>
      <Icon name="menu" opacity={0.66} />
    </button>
  );
}
