import { type ReactNode, useState } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { Drawer } from './Drawer';
import { useViewport } from '../../hooks/useViewport';
import styles from './Layout.module.css';

interface LayoutProps {
  children: ReactNode;
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export function Layout({ children, activeTab, setActiveTab }: LayoutProps) {
  const { isMobile } = useViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className={styles.outerWrap}>
    <div className={styles.container}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {!isMobile && <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />}
      <div className={styles.main}>
        <Header onMenuClick={() => setDrawerOpen(true)} />
        <main id="main-content" className={styles.content}>
          {children}
        </main>
      </div>
      {isMobile && (
        <>
          <MobileNav activeTab={activeTab} setActiveTab={setActiveTab} />
          <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
            <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} onNavigate={() => setDrawerOpen(false)} />
          </Drawer>
        </>
      )}
    </div>
    </div>
  );
}
