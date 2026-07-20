import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { cn } from '../lib/utils.ts';
import { 
  LayoutDashboard, 
  Shield, 
  Settings, 
  DownloadCloud, 
  CreditCard, 
  LifeBuoy, 
  UserCircle, 
  LogOut,
  Menu,
  X,
  Bell,
  Activity,
  Flame
} from 'lucide-react';

export const Layout: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navItems = [
    { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
    { name: 'My VPN', path: '/my-vpn', icon: Shield },
    { name: 'Configurations', path: '/configurations', icon: Settings },
    { name: 'Downloads', path: '/downloads', icon: DownloadCloud },
    { name: 'Billing', path: '/billing', icon: CreditCard },
    { name: 'Support', path: '/support', icon: LifeBuoy },
    { name: 'Profile', path: '/profile', icon: UserCircle },
  ];

  if (user?.role === 'admin') {
    navItems.push({ name: 'Admin Panel', path: '/admin', icon: Activity });
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex overflow-hidden font-sans">
      
      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-40 lg:hidden backdrop-blur-sm"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 z-50 w-60 bg-bg-secondary border-r border-border-color flex flex-col shrink-0 transition-transform duration-300 ease-in-out",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        <div className="p-6 mb-2 flex items-center shrink-0">
          <NavLink to="/" className="flex items-center gap-2 text-xl font-bold text-white italic">
            <span className="text-orange-500 not-italic text-2xl">🔥</span> FIREVPNs
          </NavLink>
          <button className="ml-auto lg:hidden" onClick={() => setIsSidebarOpen(false)}>
            <X className="w-6 h-6 text-gray-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.name}
              to={item.path}
              onClick={() => setIsSidebarOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-all",
                  isActive 
                    ? "bg-blue-600/10 text-blue-400 border border-blue-500/20 font-medium" 
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                )
              }
            >
              <item.icon className="w-5 h-5 shrink-0" />
              {item.name}
            </NavLink>
          ))}
        </div>

        <div className="p-4 border-t border-border-color">
          <button
            onClick={handleLogout}
            className="flex w-full items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-slate-500 hover:text-red-400 transition-colors rounded-lg"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            Logout
          </button>
        </div>
      </motion.aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Navbar */}
        <header className="h-16 border-b border-border-color flex items-center justify-between px-4 lg:px-8 shrink-0 bg-bg-primary/80 backdrop-blur-md z-10 sticky top-0">
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden p-2 -ml-2 text-slate-400 hover:text-white rounded-lg hover:bg-white/5"
              onClick={() => setIsSidebarOpen(true)}
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="hidden lg:block">
              <h1 className="text-lg font-semibold text-white">System Overview</h1>
              <p className="text-xs text-slate-500">Welcome back, {user?.name}</p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <ThemeToggle />
            <div className="hidden sm:flex items-center gap-2 bg-slate-900 border border-border-color px-3 py-1.5 rounded-full">
              <div className="w-2 h-2 bg-green-500 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)]"></div>
              <span className="text-xs font-medium text-slate-300">System Online</span>
            </div>
            <div className="flex items-center gap-3">
              <button className="relative text-slate-400 hover:text-white transition-colors">
                <Bell className="w-5 h-5" />
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.6)]"></span>
              </button>
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 border border-white/20 flex items-center justify-center text-white text-xs font-bold shadow-[0_0_10px_rgba(59,130,246,0.3)]">
                {user?.name?.charAt(0).toUpperCase()}
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8 bg-bg-primary">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="max-w-7xl mx-auto w-full h-full flex flex-col"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  );
};
