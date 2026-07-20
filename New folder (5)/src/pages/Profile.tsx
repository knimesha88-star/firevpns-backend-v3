import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { UserCircle, Mail, MessageCircle, Hash, Smartphone, Key } from 'lucide-react';

export const Profile: React.FC = () => {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/users/profile')
      .then(setProfile)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-gray-400">Loading profile...</div>;

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">My Profile</h1>
        <p className="text-gray-400">Manage your account details and contact information.</p>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
        <div className="p-8 flex items-center gap-6 border-b border-white/10">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-4xl text-white font-medium shadow-lg shadow-blue-500/20">
            {profile?.name?.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white mb-1">{profile?.name}</h2>
            <p className="text-gray-400">{profile?.role === 'admin' ? 'Administrator' : 'Customer'}</p>
          </div>
        </div>

        <div className="p-8">
          <h3 className="text-lg font-bold text-white mb-6">Personal Information</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Full Name</label>
              <div className="flex items-center gap-3 bg-black/40 border border-white/5 rounded-xl px-4 py-3">
                <UserCircle className="w-5 h-5 text-gray-500" />
                <span className="text-white">{profile?.name}</span>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Email Address</label>
              <div className="flex items-center gap-3 bg-black/40 border border-white/5 rounded-xl px-4 py-3">
                <Mail className="w-5 h-5 text-gray-500" />
                <span className="text-white">{profile?.email}</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Username</label>
              <div className="flex items-center gap-3 bg-black/40 border border-white/5 rounded-xl px-4 py-3">
                <Hash className="w-5 h-5 text-gray-500" />
                <span className="text-white">{profile?.username}</span>
              </div>
            </div>
          </div>

          <h3 className="text-lg font-bold text-white mb-6 pt-6 border-t border-white/10">Contact Methods</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Telegram</label>
              <div className="flex items-center gap-3 bg-black/40 border border-white/5 rounded-xl px-4 py-3">
                <MessageCircle className="w-5 h-5 text-blue-400" />
                <span className="text-white">{profile?.telegram || 'Not provided'}</span>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">WhatsApp</label>
              <div className="flex items-center gap-3 bg-black/40 border border-white/5 rounded-xl px-4 py-3">
                <Smartphone className="w-5 h-5 text-green-400" />
                <span className="text-white">{profile?.whatsapp || 'Not provided'}</span>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Discord</label>
              <div className="flex items-center gap-3 bg-black/40 border border-white/5 rounded-xl px-4 py-3">
                <MessageCircle className="w-5 h-5 text-indigo-400" />
                <span className="text-white">{profile?.discord || 'Not provided'}</span>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-white/10 flex justify-end">
            <button className="flex items-center gap-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-white font-medium transition-colors">
              <Key className="w-4 h-4" /> Change Password
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
