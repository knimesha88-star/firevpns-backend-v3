import React, { useState, useEffect } from 'react';
import { Users, Server, Activity, ArrowUpRight, ArrowDownRight, Search, UserPlus, LayoutDashboard, Settings, FileText, Database, CreditCard, LifeBuoy, Zap } from 'lucide-react';
import { cn } from '../lib/utils.ts';
import { api } from '../lib/api.ts';
import { UserManagement } from '../components/admin/UserManagement.tsx';
import { XuiIntegration } from '../components/admin/XuiIntegration.tsx';
import { useAuth } from '../contexts/AuthContext.tsx';

export const AdminDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState({ users: 0, activeVpns: 0 });
  const { user } = useAuth();

  useEffect(() => {
    // Replace with real backend call
    api.get('/admin/stats')
      .then(data => {
        if (data && data.success) {
           setStats(data.data || { users: 0, activeVpns: 0 });
        }
      })
      .catch(console.error);
  }, []);

  const tabs = [
    { id: 'dashboard', name: 'Dashboard', icon: LayoutDashboard },
    { id: 'users', name: 'User Management', icon: Users },
    { id: 'vpn', name: 'VPN Management', icon: Server },
    { id: 'xui', name: '3X-UI Integration', icon: Zap },
    { id: 'customers', name: 'Customer Accounts', icon: Database },
    { id: 'billing', name: 'Billing', icon: CreditCard },
    { id: 'support', name: 'Support Tickets', icon: LifeBuoy },
    { id: 'settings', name: 'Settings', icon: Settings },
    { id: 'logs', name: 'System Logs', icon: FileText },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Admin Panel</h1>
        <p className="text-gray-400">Manage the entire FIREVPNs platform and infrastructure.</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Admin Navigation */}
        <div className="w-full lg:w-64 shrink-0">
          <nav className="flex lg:flex-col gap-2 overflow-x-auto pb-4 lg:pb-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all whitespace-nowrap",
                  activeTab === tab.id
                    ? "bg-blue-600/10 text-blue-400 border border-blue-500/20"
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                )}
              >
                <tab.icon className="w-5 h-5" />
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1">
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <div className="flex items-center gap-3 mb-4 text-gray-400">
                    <Users className="w-5 h-5" />
                    <h3 className="font-medium">Total Customers</h3>
                  </div>
                  <div className="flex items-end gap-3">
                    <span className="text-4xl font-bold text-white">{stats.users}</span>
                    <span className="flex items-center text-sm font-medium text-emerald-400 mb-1">
                      <ArrowUpRight className="w-4 h-4" /> 12%
                    </span>
                  </div>
                </div>
                
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <div className="flex items-center gap-3 mb-4 text-gray-400">
                    <Server className="w-5 h-5" />
                    <h3 className="font-medium">Active Subscriptions</h3>
                  </div>
                  <div className="flex items-end gap-3">
                    <span className="text-4xl font-bold text-white">{stats.activeVpns}</span>
                    <span className="flex items-center text-sm font-medium text-emerald-400 mb-1">
                      <ArrowUpRight className="w-4 h-4" /> 5%
                    </span>
                  </div>
                </div>

                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <div className="flex items-center gap-3 mb-4 text-gray-400">
                    <Activity className="w-5 h-5" />
                    <h3 className="font-medium">Traffic Used (30d)</h3>
                  </div>
                  <div className="flex items-end gap-3">
                    <span className="text-4xl font-bold text-white">4.2 TB</span>
                    <span className="flex items-center text-sm font-medium text-red-400 mb-1">
                      <ArrowDownRight className="w-4 h-4" /> 2%
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-center text-gray-400">
                Detailed metrics and charts will appear here.
              </div>
            </div>
          )}

          {activeTab === 'users' && (
            <UserManagement />
          )}

          {activeTab === 'xui' && (
            <XuiIntegration />
          )}

          {activeTab !== 'dashboard' && activeTab !== 'users' && activeTab !== 'xui' && (
            <div className="bg-white/5 border border-white/10 rounded-2xl p-12 text-center">
              <Activity className="w-12 h-12 text-slate-500 mx-auto mb-4 opacity-50" />
              <h2 className="text-xl font-bold text-white mb-2">{tabs.find(t => t.id === activeTab)?.name} Module</h2>
              <p className="text-slate-400 max-w-md mx-auto">This section is currently under development. Analytics and management tools will be available soon.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
