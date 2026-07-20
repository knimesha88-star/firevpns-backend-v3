import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { LifeBuoy, Plus, MessageSquare } from 'lucide-react';

export const Support: React.FC = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/users/support')
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-gray-400">Loading support tickets...</div>;

  const tickets = data?.tickets || [];

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Support Center</h1>
          <p className="text-gray-400">We are here to help. Manage your support tickets or check the FAQ.</p>
        </div>
        <button className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
          <Plus className="w-5 h-5" /> New Ticket
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-xl font-bold text-white mb-4">Your Tickets</h2>
          
          {tickets.length === 0 ? (
            <div className="p-12 border border-white/10 rounded-2xl bg-white/5 text-center">
              <LifeBuoy className="w-12 h-12 text-gray-500 mx-auto mb-4" />
              <h3 className="text-lg font-bold text-white mb-2">No active tickets</h3>
              <p className="text-gray-400">You don't have any support tickets at the moment.</p>
            </div>
          ) : (
            tickets.map((ticket: any) => (
              <div key={ticket.id} className="p-6 border border-white/10 rounded-2xl bg-white/5 hover:bg-white/10 transition-colors cursor-pointer group">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-white group-hover:text-blue-400 transition-colors">{ticket.subject}</h3>
                    <p className="text-sm text-gray-400 mt-1">Ticket #{ticket.id.split('-')[1]} • Opened {new Date(ticket.createdAt).toLocaleDateString()}</p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                    ticket.status === 'open' ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' : 
                    'bg-green-500/10 text-green-400 border border-green-500/20'
                  }`}>
                    {ticket.status}
                  </span>
                </div>
                
                <div className="bg-black/40 rounded-xl p-4 border border-white/5 flex items-start gap-3">
                  <MessageSquare className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
                  <p className="text-sm text-gray-300 line-clamp-2">
                    {ticket.messages[ticket.messages.length - 1]?.text}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h2 className="text-lg font-bold text-white mb-4">Live Chat</h2>
            <p className="text-sm text-gray-400 mb-6">Need immediate assistance? Talk to our support agents directly.</p>
            <button className="w-full py-3 bg-white hover:bg-gray-200 text-black font-bold rounded-xl transition-colors">
              Start Chat
            </button>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h2 className="text-lg font-bold text-white mb-4">FAQ</h2>
            <div className="space-y-4">
              <a href="#" className="block text-sm text-blue-400 hover:text-blue-300">How to setup VPN on Router?</a>
              <a href="#" className="block text-sm text-blue-400 hover:text-blue-300">Why is my speed slow?</a>
              <a href="#" className="block text-sm text-blue-400 hover:text-blue-300">How to change my password?</a>
              <a href="#" className="block text-sm text-blue-400 hover:text-blue-300">Can I share my account?</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
