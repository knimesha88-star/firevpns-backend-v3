import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { api } from '../lib/api.ts';
import { 
  Shield, 
  Copy, 
  QrCode, 
  Download,
  Server,
  Lock,
  Globe,
  Wifi,
  Calendar,
  Database
} from 'lucide-react';

export const MyVPN: React.FC = () => {
  const { user } = useAuth();
  const [vpn, setVpn] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user?.email) return;

    api.get('/client/status')
      .then((resData) => {
        if (resData.success && resData.data) {
          setVpn(resData.data);
        } else {
          setVpn(null);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [user]);

  const handleCopy = () => {
    if (!vpn) return;
    const configString = vpn.connectionUri || vpn.uri || `${vpn.protocol || 'vless'}://${vpn.uuid || vpn.id}@${vpn.serverAddress || 'server'}:${vpn.port || 443}?type=${vpn.network || 'tcp'}&security=${vpn.security || 'none'}#${vpn.serverName || vpn.name || 'VPN'}`;
    navigator.clipboard.writeText(configString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return <div className="text-gray-400">Loading VPN details...</div>;
  
  if (!vpn) return (
    <div className="flex flex-col items-center justify-center p-12 text-center border border-white/10 rounded-2xl bg-white/5">
      <Shield className="w-16 h-16 text-gray-500 mb-4" />
      <h2 className="text-xl font-bold text-white mb-2">No VPN information available.</h2>
      <p className="text-gray-400 mb-6">You don't have an active VPN subscription right now.</p>
      <button className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors">
        Purchase a Plan
      </button>
    </div>
  );

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const configString = vpn.connectionUri || vpn.uri || `${vpn.protocol || 'vless'}://${vpn.uuid || vpn.id}@${vpn.serverAddress || 'server'}:${vpn.port || 443}?type=${vpn.network || 'tcp'}&security=${vpn.security || 'none'}#${vpn.serverName || vpn.name || 'VPN'}`;

  const used = vpn.trafficUsed || vpn.down || 0;
  const limit = vpn.trafficLimit || vpn.total || 0;
  const percent = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white mb-1">My VPN</h1>
        <p className="text-xs text-slate-500">Manage your active VPN connection details and configurations.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Main Details */}
        <div className="col-span-1 lg:col-span-2 space-y-6">
          <div className="bg-[#0A0C1A] border border-white/10 rounded-2xl p-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 blur-[80px] -z-0"></div>
            <div className="relative z-10">
              <h2 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                <Server className="w-5 h-5 text-blue-400" />
                Connection Details
              </h2>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase tracking-wider">Protocol</p>
                  <p className="font-mono text-cyan-400 text-sm bg-cyan-950/30 px-2 py-1 rounded inline-block">{vpn.protocol || 'N/A'}</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase tracking-wider">Server Address</p>
                  <p className="font-mono text-white text-sm truncate">{vpn.serverAddress || 'N/A'}</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase tracking-wider">Port</p>
                  <p className="font-mono text-white text-sm">{vpn.port || 'N/A'}</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm col-span-2 md:col-span-1">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase tracking-wider">UUID</p>
                  <p className="font-mono text-purple-400 text-sm truncate bg-purple-950/30 px-2 py-1 rounded inline-block" title={vpn.uuid || vpn.id}>{vpn.uuid || vpn.id || 'N/A'}</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase tracking-wider flex items-center gap-1"><Wifi className="w-3 h-3"/> Network</p>
                  <p className="font-mono text-white text-sm uppercase">{vpn.network || 'N/A'}</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                  <p className="text-xs text-slate-500 mb-1 font-bold uppercase tracking-wider flex items-center gap-1"><Lock className="w-3 h-3"/> Security</p>
                  <p className="font-mono text-white text-sm uppercase">{vpn.security || 'N/A'}</p>
                </div>
              </div>

              <div className="mt-6 p-5 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between gap-4">
                 <div className="flex-1 space-y-2">
                   <p className="text-xs text-slate-500 uppercase font-bold tracking-wider">Config URL</p>
                   <input 
                     type="text" 
                     readOnly 
                     value={configString}
                     className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-cyan-400 font-mono text-sm outline-none"
                   />
                 </div>
                 <div className="flex flex-col gap-2 shrink-0">
                   <button 
                    onClick={handleCopy}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-all shadow-lg shadow-blue-900/20 flex items-center gap-2 justify-center"
                   >
                     {copied ? <Shield className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied!' : 'Copy URL'}
                   </button>
                 </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Side */}
        <div className="space-y-6">
          <div className="bg-[#0A0C1A] border border-white/10 rounded-2xl p-6">
            <h2 className="text-sm font-bold text-white mb-6 border-b border-white/5 pb-4">Status & Usage</h2>
            
            <div className="space-y-6">
              <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🛡️</span>
                  <div>
                    <p className="text-sm font-bold text-white capitalize">{vpn.status || vpn.vpnStatus || 'Active'}</p>
                    <p className="text-[10px] text-slate-500">Subscription Status</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">📅</span>
                  <div>
                    <p className="text-sm font-bold text-white">{vpn.expiryDate ? new Date(vpn.expiryDate).toLocaleDateString() : 'N/A'}</p>
                    <p className="text-[10px] text-slate-500">Expiry Date</p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-white/5 rounded-xl border border-white/5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">📊</span>
                  <span className="text-sm font-bold text-white">Traffic Usage</span>
                </div>
                <div className="w-full">
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider mb-2">
                    <span className="text-slate-500">Total Used</span>
                    <span className="text-white">{formatBytes(used)} / {formatBytes(limit)}</span>
                  </div>
                  <div className="w-full h-1.5 bg-black/40 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.6)]" 
                      style={{ width: `${percent}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-[#0A0C1A] border border-white/10 rounded-2xl p-6 flex items-center justify-between">
            <div className="space-y-3 flex-1">
              <button className="w-full px-4 py-2 border border-white/10 hover:bg-white/5 rounded-lg text-xs font-medium text-white transition-all flex items-center justify-center gap-2">
                <QrCode className="w-4 h-4" /> View QR
              </button>
              <button className="w-full px-4 py-2 border border-white/10 hover:bg-white/5 rounded-lg text-xs font-medium text-white transition-all flex items-center justify-center gap-2">
                <Download className="w-4 h-4" /> Get JSON
              </button>
            </div>
            <div className="w-24 h-24 bg-white p-2 rounded-lg flex items-center justify-center ml-4 shrink-0">
              <div className="w-full h-full bg-black/5 rounded flex flex-col items-center justify-center text-[8px] text-black font-bold text-center">
                QR CODE
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
