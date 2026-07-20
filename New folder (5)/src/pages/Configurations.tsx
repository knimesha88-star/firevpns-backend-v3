import React from 'react';
import { Settings, Copy, Plus, Terminal } from 'lucide-react';

export const Configurations: React.FC = () => {
  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">My Configurations</h1>
          <p className="text-gray-400">Manage multiple VPN configuration profiles and custom server setups.</p>
        </div>
        <button className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
          <Plus className="w-5 h-5" /> Import Profile
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-blue-500/30 transition-colors">
          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-lg">
                <Settings className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Main Profile</h3>
                <p className="text-sm text-green-400">Active</p>
              </div>
            </div>
            <button className="text-gray-400 hover:text-white p-2 bg-white/5 rounded-lg transition-colors">
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2 mt-6">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Protocol</span>
              <span className="text-gray-300 font-mono">VLESS</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Nodes</span>
              <span className="text-gray-300">12</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Last Synced</span>
              <span className="text-gray-300">Today, 10:45 AM</span>
            </div>
          </div>
        </div>

        <div className="bg-white/5 border border-white/10 border-dashed rounded-2xl p-6 flex flex-col items-center justify-center text-center hover:bg-white/10 transition-colors cursor-pointer min-h-[220px]">
          <Terminal className="w-10 h-10 text-gray-500 mb-4" />
          <h3 className="text-lg font-bold text-white mb-2">Create Custom Config</h3>
          <p className="text-sm text-gray-400 max-w-xs">Generate a specialized configuration for specific clients like Clash, v2rayN, or NekoBox.</p>
        </div>
      </div>
    </div>
  );
};
