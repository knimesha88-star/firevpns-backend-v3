import { api } from '../../lib/api.ts';
import React, { useState, useEffect } from 'react';
import { Server, Activity, Users, Database, Shield, RefreshCw, Download, Zap, AlertCircle, CheckCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase.ts';

export const XuiIntegration: React.FC = () => {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [lastSync, setLastSync] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    panelUrl: '',
    username: '',
    password: '',
    panelName: 'Primary Node'
  });

  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      console.log("Before getDoc (fetchSettings)");
      const docRef = doc(db, 'settings', 'xui');
      const docSnap = await getDoc(docRef);
      console.log("After getDoc (fetchSettings)");
      if (docSnap.exists()) {
        const data = docSnap.data();
        setFormData({
          panelUrl: data.panelUrl || '',
          username: data.username || '',
          password: data.password ? '********' : '',
          panelName: data.panelName || 'Primary Node'
        });
        setStatus(data.status || 'disconnected');
        setLastSync(data.lastSync ? (data.lastSync.toDate ? data.lastSync.toDate().toLocaleString() : new Date(data.lastSync).toLocaleString()) : null);
      }
    } catch (error: any) {
      console.error("Full error object from getDoc (fetchSettings):", error);
      console.error("Error Code:", error.code);
      console.error("Error Message:", error.message);
      console.error("Error Stack:", error.stack);
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  
  const [panelStats, setPanelStats] = useState({ version: 'v2.4.3', clients: '1,248', online: '342', traffic: '4.2 TB' });

  const fetchLiveData = async () => {
    try {
      const statusRes = await api.get('/3xui/status');
      const inboundsRes = await api.get('/xui/inbounds');
      console.log('Status:', statusRes);
      console.log('Inbounds:', inboundsRes);
      if (statusRes && statusRes.success && statusRes.status && statusRes.status.obj) {
          // just an example of handling it
      }
    } catch (err) {
      console.error('Failed to fetch live data:', err);
    }
  };

  const handleTestConnection = async () => {
    try {
      setTesting(true);
      setMessage(null);
      
      let actualPassword = formData.password;
      if (actualPassword === '********') {
        const docSnap = await getDoc(doc(db, 'settings', 'xui'));
        if (docSnap.exists()) {
          actualPassword = docSnap.data().password;
        }
      }

      const res = await api.post('/3xui/test', {
          panelUrl: formData.panelUrl,
          username: formData.username,
          password: actualPassword
      });
      
      if (res && res.success && res.connected) {
        setMessage({ type: 'success', text: 'Connected to 3X-UI successfully.' });
      } else {
        setMessage({ type: 'error', text: 'Connection failed.' });
      }
    } catch (error: any) {
      console.error('Test connection error:', error);
      setMessage({ type: 'error', text: error.message || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveConnection = async () => {
    try {
      setSaving(true);
      setMessage(null);

      let actualPassword = formData.password;
      if (actualPassword === '********') {
        const docSnap = await getDoc(doc(db, 'settings', 'xui'));
        if (docSnap.exists()) {
          actualPassword = docSnap.data().password;
        }
      }

      const res = await api.post('/3xui/settings', {
          panelUrl: formData.panelUrl,
          username: formData.username,
          password: actualPassword,
          panelName: formData.panelName
      });
      
      if (res && res.success) {
         setStatus(res.connected ? 'connected' : 'disconnected');
         setMessage({ type: res.connected ? 'success' : 'error', text: res.connected ? 'Settings saved and connected successfully.' : 'Settings saved but connection failed.' });
         fetchSettings();
      }
    } catch (error: any) {
      console.error('Save connection error:', error);
      setMessage({ type: 'error', text: error.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm("Are you sure you want to disconnect? Live sync will stop working.")) return;
    try {
      setMessage(null);
      await api.delete('/3xui/settings');
      setFormData({ panelUrl: '', username: '', password: '', panelName: 'Primary Node' });
      setStatus('disconnected');
      setLastSync(null);
      setMessage({ type: 'success', text: 'Disconnected successfully.' });
    } catch (error: any) {
      console.error('Failed to disconnect:', error);
      setMessage({ type: 'error', text: error.message || 'Failed to disconnect.' });
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400">Loading settings...</div>;
  }

  return (
    <div className="space-y-6">
      {message && (
        <div className={`p-4 rounded-lg flex items-center gap-3 font-medium text-sm ${
          message.type === 'success' 
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Connection Form */}
        <div className="xl:col-span-2 space-y-6">
          <div className="bg-[#0A0C1A] border border-white/10 rounded-2xl overflow-hidden">
            <div className="p-6 border-b border-white/10 flex items-center gap-3">
              <Server className="w-6 h-6 text-blue-500" />
              <h2 className="text-xl font-bold text-white">3X-UI Panel Connection</h2>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">Panel Name</label>
                  <input 
                    name="panelName" 
                    value={formData.panelName} 
                    onChange={handleInputChange} 
                    type="text" 
                    className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500" 
                    placeholder="E.g., Primary Node" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">Panel URL</label>
                  <input 
                    name="panelUrl" 
                    value={formData.panelUrl} 
                    onChange={handleInputChange} 
                    type="url" 
                    className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500" 
                    placeholder="http://192.168.1.100:2053" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">Username</label>
                  <input 
                    name="username" 
                    value={formData.username} 
                    onChange={handleInputChange} 
                    type="text" 
                    className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">API Token / Password</label>
                  <input 
                    name="password" 
                    value={formData.password} 
                    onChange={handleInputChange} 
                    type="password" 
                    className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500" 
                    placeholder={formData.password === '********' ? '********' : ''}
                  />
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-white/10 bg-white/[0.02] flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500'}`}></div>
                <span className="text-sm font-medium text-slate-300 capitalize">{status}</span>
              </div>
              <div className="flex gap-3">
                {status === 'connected' && (
                  <button 
                    onClick={handleDisconnect}
                    className="px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    Disconnect
                  </button>
                )}
                <button 
                  onClick={handleTestConnection}
                  disabled={testing || !formData.panelUrl}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  {testing ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : null}
                  Test Connection
                </button>
                <button 
                  onClick={handleSaveConnection}
                  disabled={saving || !formData.panelUrl}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  {saving ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Shield className="w-4 h-4" />}
                  Save Connection
                </button>
              </div>
            </div>
          </div>

          {/* Sync Actions */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button className="bg-[#0A0C1A] border border-white/10 hover:bg-white/5 transition-colors p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-3 group">
              <div className="w-12 h-12 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                <RefreshCw className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-medium text-white">Sync Clients</h3>
                <p className="text-xs text-slate-400 mt-1">Push local changes to panel</p>
              </div>
            </button>
            <button className="bg-[#0A0C1A] border border-white/10 hover:bg-white/5 transition-colors p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-3 group">
              <div className="w-12 h-12 rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Download className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-medium text-white">Import Clients</h3>
                <p className="text-xs text-slate-400 mt-1">Pull new clients from panel</p>
              </div>
            </button>
            <button onClick={fetchLiveData} className="bg-[#0A0C1A] border border-white/10 hover:bg-white/5 transition-colors p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-3 group">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Zap className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-medium text-white">Refresh Live Data</h3>
                <p className="text-xs text-slate-400 mt-1">Update traffic & online status</p>
              </div>
            </button>
          </div>
        </div>

        {/* Status Panel */}
        <div className="space-y-6">
          <div className="bg-[#0A0C1A] border border-white/10 rounded-2xl overflow-hidden">
            <div className="p-6 border-b border-white/10">
              <h3 className="font-bold text-white">Panel Overview</h3>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between items-center pb-4 border-b border-white/5">
                <span className="text-slate-400 text-sm">Panel Version</span>
                <span className="text-white font-mono text-sm">{panelStats.version}</span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-white/5">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Users className="w-4 h-4" /> Total Clients
                </div>
                <span className="text-white font-medium">{panelStats.clients}</span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-white/5">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Activity className="w-4 h-4" /> Online Users
                </div>
                <span className="text-emerald-400 font-medium">{panelStats.online}</span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-white/5">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Database className="w-4 h-4" /> Total Traffic (30d)
                </div>
                <span className="text-white font-medium">{panelStats.traffic}</span>
              </div>
              <div className="flex justify-between items-center pt-2">
                <span className="text-slate-500 text-xs">Last Sync</span>
                <span className="text-slate-400 text-xs">{lastSync || 'Never'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
