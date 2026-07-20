import React from 'react';
import { CreditCard, CheckCircle2, History, AlertCircle } from 'lucide-react';

export const Billing: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Billing & Plans</h1>
        <p className="text-gray-400">Manage your subscription, payment methods, and billing history.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-gradient-to-br from-blue-900/40 to-purple-900/40 border border-blue-500/20 rounded-2xl p-8 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-8 opacity-20">
              <CreditCard className="w-32 h-32 text-blue-400" />
            </div>
            <div className="relative z-10">
              <span className="inline-block px-3 py-1 bg-blue-500 text-white text-xs font-bold uppercase tracking-wider rounded-full mb-4">Active Plan</span>
              <h2 className="text-3xl font-bold text-white mb-2">Premium Global VPN</h2>
              <p className="text-gray-300 mb-6">Your plan automatically renews on <span className="text-white font-medium">Aug 15, 2026</span></p>
              
              <div className="flex flex-wrap items-center gap-4">
                <button className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-colors">
                  Renew Now
                </button>
                <button className="px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/10 text-white font-medium rounded-xl transition-colors">
                  Change Plan
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <History className="w-5 h-5 text-gray-400" /> Billing History
            </h3>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-sm text-gray-400">
                    <th className="pb-3 font-medium">Date</th>
                    <th className="pb-3 font-medium">Description</th>
                    <th className="pb-3 font-medium">Amount</th>
                    <th className="pb-3 font-medium">Status</th>
                    <th className="pb-3 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody className="text-sm text-gray-300">
                  <tr className="border-b border-white/5">
                    <td className="py-4">Jul 15, 2026</td>
                    <td className="py-4 text-white">Premium Global VPN (1 Month)</td>
                    <td className="py-4">$9.99</td>
                    <td className="py-4">
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 className="w-4 h-4" /> Paid
                      </span>
                    </td>
                    <td className="py-4"><button className="text-blue-400 hover:text-blue-300">Download</button></td>
                  </tr>
                  <tr>
                    <td className="py-4">Jun 15, 2026</td>
                    <td className="py-4 text-white">Premium Global VPN (1 Month)</td>
                    <td className="py-4">$9.99</td>
                    <td className="py-4">
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 className="w-4 h-4" /> Paid
                      </span>
                    </td>
                    <td className="py-4"><button className="text-blue-400 hover:text-blue-300">Download</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h3 className="text-lg font-bold text-white mb-4">Payment Method</h3>
            <div className="p-4 bg-black/40 border border-white/10 rounded-xl mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-6 bg-gray-200 rounded flex items-center justify-center text-xs font-bold text-blue-900">
                  VISA
                </div>
                <div>
                  <p className="text-white text-sm font-medium">•••• 4242</p>
                  <p className="text-xs text-gray-500">Expires 12/28</p>
                </div>
              </div>
              <button className="text-sm text-blue-400 hover:text-blue-300">Edit</button>
            </div>
            <button className="w-full py-3 bg-white/5 hover:bg-white/10 border border-dashed border-white/20 text-gray-300 rounded-xl transition-colors">
              + Add Payment Method
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
