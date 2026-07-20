import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../lib/api.ts';
import { cn } from '../lib/utils.ts';
import { 
  Shield, 
  Activity, 
  Globe, 
  Clock, 
  Upload, 
  Download, 
  Database, 
  Zap,
  CheckCircle2,
  AlertCircle,
  Settings,
  Bell,
  Gift,
  ArrowRight,
  RefreshCw,
  Power,
  XCircle,
  User,
  Mail,
  Smartphone,
  MessageCircle,
  Hash,
  MessageSquare
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.tsx';

export const Dashboard: React.FC = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.email) return;
    
    api.get('/client/status')
      .then((resData) => {
        if (resData && resData.success && resData.data) {
          setData(resData.data);
        } else {
          setData(null);
        }
      })
      .catch((err) => {
        console.error(err);
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) {
    return <div className="text-gray-400">Loading your dashboard...</div>;
  }

  const isConnected = data?.vpnStatus === 'active' || data?.vpnStatus === 'connected';

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(3)) + ' ' + sizes[i];
  };

  const usagePercent = data && data.trafficLimit ? (data.totalDataUsed / data.trafficLimit) * 100 : 0;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Notifications Banner */}
      <div className="bg-bg-secondary border border-blue-900/30 rounded-xl p-4 flex items-start gap-4">
        <div className="p-2 bg-blue-500/20 text-blue-400 rounded-lg shrink-0 mt-1">
          <Bell className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
              🎉 Free Trial Approved!
            </h3>
            <span className="text-[10px] text-slate-500">30 Jun 2026, 10:06 AM</span>
          </div>
          <p className="text-xs text-text-secondary mt-1">
            Your free trial has been approved! Check My VPNs to get your connection code.
          </p>
          <div className="flex items-center gap-4 mt-3">
            <Link to="/my-vpn" className="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1">
              View Details <ArrowRight className="w-3 h-3" />
            </Link>
            <button className="text-xs text-slate-500 hover:text-slate-300 font-medium flex items-center gap-1">
              All Notifications ≡
            </button>
          </div>
        </div>
      </div>

      {/* Promo Banner */}
      <div className="bg-gradient-to-r from-[#1E1B4B] to-[#312E81] border border-indigo-500/30 rounded-xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-white/10 text-text-primary rounded-xl shrink-0">
            <Gift className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-text-primary uppercase tracking-wider">Free VIP Merchandise</h2>
            <p className="text-xs text-indigo-200 mt-1 max-w-md">
              Claim your exclusive CloudNet premium silicone wristband today. Limited stock available for our paid members!
            </p>
          </div>
        </div>
        <button className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-text-primary text-sm font-bold rounded-lg transition-colors shadow-lg shadow-emerald-500/20 whitespace-nowrap">
          Claim Now →
        </button>
      </div>

      {/* Plan Header */}
      {data ? (
        <div className="flex items-center gap-2 text-xs font-bold text-text-secondary tracking-wider">
          <Shield className="w-4 h-4 text-blue-500" />
          PLAN <span className="text-text-primary">{data.subscriptionName || data.name || 'ACTIVE PLAN'}</span>
          <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px]">LIVE</span>
        </div>
      ) : null}

      {/* 4 Panels Row */}
      {!data ? (
        <div className="bg-[#1A1C2A] border border-white/5 rounded-xl p-6 flex items-center justify-center min-h-[200px]">
          <p className="text-text-secondary font-medium">No VPN information available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* VPN Status */}
          <div className={cn("rounded-xl p-6 flex flex-col justify-center relative overflow-hidden shadow-lg", isConnected ? "bg-emerald-500 shadow-emerald-500/20" : "bg-red-500 shadow-red-500/20")}>
            <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/10 rounded-full blur-xl"></div>
            <p className={cn("text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5", isConnected ? "text-emerald-900" : "text-red-900")}>
              <Globe className="w-3 h-3" /> VPN Status
            </p>
            <div className="flex items-center gap-2 mb-1">
              <div className={cn("w-2.5 h-2.5 bg-white rounded-full", isConnected ? "shadow-[0_0_8px_rgba(255,255,255,0.8)] animate-pulse" : "")}></div>
              <h2 className="text-3xl font-bold text-text-primary capitalize">{data.vpnStatus || data.status || 'Active'}</h2>
            </div>
            <p className={cn("text-xs font-medium", isConnected ? "text-emerald-100" : "text-red-100")}>{data.serverName || 'My VPN Server'}</p>
          </div>

          {/* Expires In */}
          <div className="bg-[#1A1C2A] border border-white/5 rounded-xl p-6 flex flex-col justify-center relative overflow-hidden">
            <p className="text-[10px] text-text-secondary font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-blue-500" /> Expiry
            </p>
            <h2 className="text-3xl font-bold text-text-primary mb-1">
              {data.expiryDate ? new Date(data.expiryDate).toLocaleDateString() : 'N/A'}
            </h2>
            <p className="text-xs text-slate-500 font-medium">Subscription End Date</p>
          </div>

          {/* Data Used */}
          <div className="bg-[#1A1C2A] border border-white/5 rounded-xl p-6 flex flex-col justify-center">
            <p className="text-[10px] text-text-secondary font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Activity className="w-3 h-3 text-orange-500" /> Data Used
            </p>
            <h2 className="text-2xl font-bold text-text-primary mb-1">
              {formatBytes(data.totalDataUsed || data.down || 0).split(' ')[0]} <span className="text-sm font-normal text-text-secondary">{formatBytes(data.totalDataUsed || data.down || 0).split(' ')[1]}</span>
            </h2>
            <p className="text-xs text-slate-500">
              Limit: {formatBytes(data.trafficLimit || data.total || 0)} ({usagePercent.toFixed(1)}%)
            </p>
          </div>

          {/* Download & Upload */}
          <div className="bg-[#1A1C2A] border border-white/5 rounded-xl p-5 flex flex-col gap-3 justify-center">
             <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-text-secondary uppercase tracking-wider">
                  <Download className="w-4 h-4 text-emerald-400" /> Down
                </div>
                <div className="text-sm font-bold text-text-primary">{formatBytes(data.down || 0)}</div>
             </div>
             <div className="w-full h-px bg-white/5"></div>
             <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-text-secondary uppercase tracking-wider">
                  <Upload className="w-4 h-4 text-blue-400" /> Up
                </div>
                <div className="text-sm font-bold text-text-primary">{formatBytes(data.up || 0)}</div>
             </div>
          </div>
        </div>
      )}

      {/* Bottom Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Account Overview */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-[#1A1C2A]/80 border border-white/5 rounded-2xl p-6">
            <h3 className="text-sm font-bold text-text-primary mb-6 flex items-center gap-2 border-b border-white/5 pb-4">
              <User className="w-4 h-4 text-blue-500" /> Account Overview
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-y-6 gap-x-12">
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Full Name</p>
                <p className="text-sm text-text-primary font-medium">{user?.displayName || 'User'}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Email</p>
                <p className="text-sm text-text-primary font-medium">{user?.email || 'N/A'}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Role</p>
                <p className="text-sm text-text-primary font-medium">Customer</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Discord</p>
                <p className="text-sm text-slate-500">—</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Telegram</p>
                <p className="text-sm text-slate-500">—</p>
              </div>
            </div>

            <div className="mt-8 pt-4 border-t border-white/5">
              <Link to="/profile" className="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1">
                Edit Profile →
              </Link>
            </div>
          </div>
        </div>

        {/* Right Column - Quick Links & Widgets */}
        <div className="space-y-6">
          {/* Quick Links */}
          <div className="bg-[#1A1C2A]/80 border border-white/5 rounded-2xl p-6">
            <h3 className="text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-4">Quick Links</h3>
            <div className="space-y-1">
              <Link to="/downloads" className="flex items-center justify-between py-3 px-4 -mx-4 hover:bg-white/5 rounded-lg transition-colors group">
                <div className="flex items-center gap-3">
                  <Smartphone className="w-4 h-4 text-blue-500" />
                  <span className="text-sm font-medium text-slate-200 group-hover:text-text-primary transition-colors">Download VPN Apps</span>
                </div>
                <ArrowRight className="w-3 h-3 text-slate-500 group-hover:text-text-primary transition-colors" />
              </Link>
              <Link to="/support" className="flex items-center justify-between py-3 px-4 -mx-4 hover:bg-white/5 rounded-lg transition-colors group">
                <div className="flex items-center gap-3">
                  <MessageCircle className="w-4 h-4 text-purple-500" />
                  <span className="text-sm font-medium text-slate-200 group-hover:text-text-primary transition-colors">Setup Tutorials</span>
                </div>
                <ArrowRight className="w-3 h-3 text-slate-500 group-hover:text-text-primary transition-colors" />
              </Link>
              <Link to="/support" className="flex items-center justify-between py-3 px-4 -mx-4 hover:bg-white/5 rounded-lg transition-colors group">
                <div className="flex items-center gap-3">
                  <MessageSquare className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-medium text-slate-200 group-hover:text-text-primary transition-colors">Open Support Ticket</span>
                </div>
                <ArrowRight className="w-3 h-3 text-slate-500 group-hover:text-text-primary transition-colors" />
              </Link>
              <Link to="/billing" className="flex items-center justify-between py-3 px-4 -mx-4 hover:bg-white/5 rounded-lg transition-colors group">
                <div className="flex items-center gap-3">
                  <Database className="w-4 h-4 text-orange-500" />
                  <span className="text-sm font-medium text-slate-200 group-hover:text-text-primary transition-colors">My Orders</span>
                </div>
                <ArrowRight className="w-3 h-3 text-slate-500 group-hover:text-text-primary transition-colors" />
              </Link>
            </div>
          </div>

          {/* Recent News */}
          <div className="bg-[#1A1C2A]/80 border border-white/5 rounded-2xl p-6">
            <h3 className="text-sm font-bold text-text-primary mb-6 flex items-center gap-2 border-b border-white/5 pb-4">
              <Activity className="w-4 h-4 text-blue-500" /> Recent News
            </h3>
            <div className="flex items-center justify-center py-6">
              <p className="text-xs text-slate-500">No recent news available.</p>
            </div>
          </div>

          {/* Support Tickets */}
          <div className="bg-[#1A1C2A]/80 border border-white/5 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6 border-b border-white/5 pb-4">
              <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
                <Hash className="w-4 h-4 text-blue-500" /> Support Tickets
              </h3>
              <Link to="/support" className="text-[10px] text-blue-400 hover:text-blue-300 font-bold uppercase tracking-wider">
                View All
              </Link>
            </div>
            
            <div className="space-y-4">
              <div className="group">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-bold text-slate-300 group-hover:text-text-primary transition-colors">#481 Billing / Payment</p>
                  <p className="text-[10px] text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> 06 May 2026</p>
                </div>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 text-[10px] text-text-secondary font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Closed
                </span>
              </div>
              
              <div className="group">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-bold text-slate-300 group-hover:text-text-primary transition-colors">#33 Other</p>
                  <p className="text-[10px] text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> 01 Apr 2026</p>
                </div>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 text-[10px] text-text-secondary font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Closed
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

