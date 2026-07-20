import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { 
  DownloadCloud, 
  Monitor, 
  Smartphone, 
  Apple, 
  Terminal,
  Wifi
} from 'lucide-react';

export const Downloads: React.FC = () => {
  const [downloads, setDownloads] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/users/downloads')
      .then(setDownloads)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-gray-400">Loading downloads...</div>;

  const platforms = [
    {
      id: 'windows',
      name: 'Windows',
      icon: Monitor,
      desc: 'Windows 10 & 11',
      color: 'text-blue-400',
      bg: 'bg-blue-500/10'
    },
    {
      id: 'mac',
      name: 'macOS',
      icon: Apple,
      desc: 'macOS 11.0 or later',
      color: 'text-white',
      bg: 'bg-white/10'
    },
    {
      id: 'android',
      name: 'Android',
      icon: Smartphone,
      desc: 'Android 8.0 or later',
      color: 'text-green-400',
      bg: 'bg-green-500/10'
    },
    {
      id: 'ios',
      name: 'iPhone / iPad',
      icon: Apple,
      desc: 'iOS 14.0 or later',
      color: 'text-white',
      bg: 'bg-white/10'
    },
    {
      id: 'linux',
      name: 'Linux',
      icon: Terminal,
      desc: 'Ubuntu, Debian, Fedora',
      color: 'text-orange-400',
      bg: 'bg-orange-500/10'
    },
    {
      id: 'router',
      name: 'Router Setup',
      icon: Wifi,
      desc: 'OpenWRT, DD-WRT',
      color: 'text-purple-400',
      bg: 'bg-purple-500/10'
    }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white mb-1">Apps & Downloads</h1>
        <p className="text-xs text-slate-500">Get FIREVPNs on all your devices. Connect instantly and securely.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {platforms.map((platform) => {
          const dlInfo = downloads?.[platform.id] || { version: 'Latest', url: '#' };
          return (
            <div key={platform.id} className="bg-[#0A0C1A] border border-white/10 rounded-2xl p-5 hover:bg-white/5 transition-colors flex flex-col h-full relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-blue-600/5 blur-[50px] -z-0"></div>
              <div className="flex items-center gap-4 mb-4 relative z-10">
                <div className={`p-3 rounded-xl ${platform.bg} ${platform.color} border border-white/5`}>
                  <platform.icon className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">{platform.name}</h3>
                  <p className="text-[10px] text-slate-500">{platform.desc}</p>
                </div>
              </div>
              
              <div className="flex-1"></div>
              
              <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between relative z-10">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider bg-black/40 px-2 py-1 rounded">v{dlInfo.version}</span>
                <a 
                  href={dlInfo.url}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-blue-600 border border-white/10 hover:border-blue-500 text-white text-xs font-bold rounded-lg transition-all"
                >
                  <DownloadCloud className="w-3 h-3" /> Download
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
