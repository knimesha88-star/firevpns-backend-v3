import React, { useState, useEffect } from 'react';
import { Search, UserPlus, X, Edit, Trash2, Shield, AlertCircle } from 'lucide-react';
import { collection, onSnapshot, doc, setDoc, deleteDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { db, secondaryAuth } from '../../lib/firebase.ts';
import { cn } from '../../lib/utils.ts';
import { motion, AnimatePresence } from 'motion/react';

interface UserData {
  id: string;
  uid: string;
  fullName?: string;
  name?: string;
  email: string;
  username?: string;
  whatsapp?: string;
  telegram?: string;
  plan?: string;
  trafficLimit?: number;
  expiryDate?: string;
  status: string;
  role: string;
  createdAt: any;
}

export const UserManagement: React.FC = () => {
  const [users, setUsers] = useState<UserData[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  
  // Form State
  const [formData, setFormData] = useState({
    uid: '',
    fullName: '',
    email: '',
    password: '',
    username: '',
    whatsapp: '',
    telegram: '',
    plan: 'free',
    trafficLimit: '50',
    expiryDate: '',
    status: 'active',
    role: 'customer'
  });

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
      const usersData: UserData[] = [];
      snapshot.forEach((doc) => {
        usersData.push({ id: doc.id, ...doc.data() } as UserData);
      });
      setUsers(usersData);
    });

    return () => unsubscribe();
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const openAddModal = () => {
    setIsEditing(false);
    setFormData({
      uid: '',
      fullName: '',
      email: '',
      password: '',
      username: '',
      whatsapp: '',
      telegram: '',
      plan: 'free',
      trafficLimit: '50',
      expiryDate: '',
      status: 'active',
      role: 'customer'
    });
    setError('');
    setIsModalOpen(true);
  };

  const openEditModal = (user: UserData) => {
    setIsEditing(true);
    setFormData({
      uid: user.uid,
      fullName: user.fullName || user.name || '',
      email: user.email,
      password: '', // Leave empty for edit
      username: user.username || '',
      whatsapp: user.whatsapp || '',
      telegram: user.telegram || '',
      plan: user.plan || 'free',
      trafficLimit: user.trafficLimit?.toString() || '50',
      expiryDate: user.expiryDate || '',
      status: user.status || 'active',
      role: user.role || 'customer'
    });
    setError('');
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isEditing) {
        // Update user
        const userRef = doc(db, 'users', formData.uid);
        await updateDoc(userRef, {
          fullName: formData.fullName,
          email: formData.email,
          username: formData.username,
          whatsapp: formData.whatsapp,
          telegram: formData.telegram,
          plan: formData.plan,
          trafficLimit: Number(formData.trafficLimit),
          expiryDate: formData.expiryDate,
          status: formData.status,
          role: formData.role,
        });
        setSuccessMsg('User updated successfully');
      } else {
        // Add new user
        if (formData.password.length < 8) {
          throw new Error('Password must be at least 8 characters');
        }

        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, formData.email, formData.password);
        await updateProfile(userCredential.user, { displayName: formData.fullName });
        
        await setDoc(doc(db, 'users', userCredential.user.uid), {
          uid: userCredential.user.uid,
          fullName: formData.fullName,
          email: formData.email,
          username: formData.username,
          whatsapp: formData.whatsapp,
          telegram: formData.telegram,
          plan: formData.plan,
          trafficLimit: Number(formData.trafficLimit),
          expiryDate: formData.expiryDate,
          status: formData.status,
          role: formData.role,
          createdAt: serverTimestamp()
        });

        // Sign out secondary auth to be clean
        await secondaryAuth.signOut();
        setSuccessMsg('User created successfully');
      }
      setIsModalOpen(false);
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      if (err.code === 'auth/email-already-in-use') {
        setError('This email is already in use.');
      } else {
        setError(err.message || 'An error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this user? This cannot be undone.')) {
      try {
        await deleteDoc(doc(db, 'users', id));
        setSuccessMsg('User deleted successfully (Note: Auth account must be deleted via admin console)');
        setTimeout(() => setSuccessMsg(''), 4000);
      } catch (err: any) {
        alert('Error deleting user: ' + err.message);
      }
    }
  };

  const filteredUsers = users.filter(u => 
    (u.fullName?.toLowerCase() || u.name?.toLowerCase() || '').includes(searchTerm.toLowerCase()) || 
    u.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
      {successMsg && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/20 p-4 text-emerald-400 text-sm font-medium flex items-center justify-center">
          {successMsg}
        </div>
      )}

      <div className="p-6 border-b border-white/10 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-xl font-bold text-white">System Users</h2>
        <div className="flex gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input 
              type="text" 
              placeholder="Search users..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-black/40 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button 
            onClick={openAddModal}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            <UserPlus className="w-4 h-4" /> <span className="hidden sm:inline">Add Client</span>
          </button>
        </div>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-black/20 border-b border-white/10 text-xs uppercase tracking-wider text-gray-500">
              <th className="px-6 py-4 font-medium">User</th>
              <th className="px-6 py-4 font-medium">Email</th>
              <th className="px-6 py-4 font-medium">Role</th>
              <th className="px-6 py-4 font-medium">Status</th>
              <th className="px-6 py-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm text-gray-300 divide-y divide-white/5">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                  No users found
                </td>
              </tr>
            ) : filteredUsers.map(user => (
              <tr key={user.id} className="hover:bg-white/5 transition-colors">
                <td className="px-6 py-4 font-medium text-white">{user.fullName || user.name || 'Unnamed'}</td>
                <td className="px-6 py-4">{user.email}</td>
                <td className="px-6 py-4 capitalize">
                  <span className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium",
                    user.role === 'admin' ? "bg-purple-500/20 text-purple-400" : "bg-blue-500/20 text-blue-400"
                  )}>
                    {user.role === 'admin' && <Shield className="w-3 h-3" />}
                    {user.role || 'Customer'}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className={cn(
                    "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium",
                    user.status === 'active' ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                  )}>
                    {user.status || 'active'}
                  </span>
                </td>
                <td className="px-6 py-4 text-right space-x-3">
                  <button onClick={() => openEditModal(user)} className="text-blue-400 hover:text-blue-300 transition-colors">
                    <Edit className="w-4 h-4 inline" />
                  </button>
                  <button onClick={() => handleDelete(user.id)} className="text-red-400 hover:text-red-300 transition-colors">
                    <Trash2 className="w-4 h-4 inline" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setIsModalOpen(false)}
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-[#0A0C1A] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="flex items-center justify-between p-6 border-b border-white/10 shrink-0">
                <h3 className="text-xl font-bold text-white">
                  {isEditing ? 'Edit Client' : 'Add New Client'}
                </h3>
                <button 
                  onClick={() => setIsModalOpen(false)}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="p-6 overflow-y-auto">
                {error && (
                  <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3 text-red-400">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <p className="text-sm">{error}</p>
                  </div>
                )}

                <form id="user-form" onSubmit={handleSubmit} className="space-y-6">
                  {/* Personal Details */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Personal Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Full Name *</label>
                        <input required name="fullName" value={formData.fullName} onChange={handleInputChange} type="text" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="John Doe" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Email *</label>
                        <input required name="email" value={formData.email} onChange={handleInputChange} type="email" disabled={isEditing} className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50" placeholder="john@example.com" />
                      </div>
                      {!isEditing && (
                        <div>
                          <label className="block text-sm font-medium text-gray-300 mb-1.5">Password *</label>
                          <input required minLength={8} name="password" value={formData.password} onChange={handleInputChange} type="password" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="••••••••" />
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Username</label>
                        <input name="username" value={formData.username} onChange={handleInputChange} type="text" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="johndoe123" />
                      </div>
                    </div>
                  </div>

                  {/* Contact Info */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Contact Info</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">WhatsApp</label>
                        <input name="whatsapp" value={formData.whatsapp} onChange={handleInputChange} type="text" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="+1234567890" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Telegram</label>
                        <input name="telegram" value={formData.telegram} onChange={handleInputChange} type="text" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="@username" />
                      </div>
                    </div>
                  </div>

                  {/* VPN & System settings */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">System Settings</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">VPN Plan</label>
                        <select name="plan" value={formData.plan} onChange={handleInputChange} className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                          <option value="free">Free Tier</option>
                          <option value="pro">Pro Tier</option>
                          <option value="ultra">Ultra Tier</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Traffic Limit (GB)</label>
                        <input name="trafficLimit" value={formData.trafficLimit} onChange={handleInputChange} type="number" min="0" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="50" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Expiry Date</label>
                        <input name="expiryDate" value={formData.expiryDate} onChange={handleInputChange} type="date" className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Account Role</label>
                        <select name="role" value={formData.role} onChange={handleInputChange} className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                          <option value="customer">Customer</option>
                          <option value="admin">Administrator</option>
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">Status</label>
                        <select name="status" value={formData.status} onChange={handleInputChange} className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                          <option value="active">Active</option>
                          <option value="suspended">Suspended</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </form>
              </div>
              
              <div className="p-6 border-t border-white/10 bg-white/[0.02] flex justify-end gap-3 shrink-0">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-6 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors rounded-lg"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  form="user-form"
                  disabled={loading}
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  {loading ? (
                    <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  ) : null}
                  {isEditing ? 'Save Changes' : 'Create Client'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
