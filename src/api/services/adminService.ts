import { supabase } from '../../lib/supabase.js';

export const getDashboardStats = async (): Promise<any> => {
  const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
  return {
    totalUsers: count || 0
  };
};

export const getAllUsers = async (): Promise<any[]> => {
  const { data: profiles } = await supabase.from('profiles').select('*');
  if (profiles && profiles.length > 0) {
    return profiles.map((p: any) => ({
      id: p.id,
      uid: p.id,
      fullName: p.full_name,
      name: p.full_name,
      email: p.email,
      role: p.role,
      createdAt: p.created_at
    }));
  }
  const { data: users } = await supabase.from('users').select('*');
  if (!users) return [];
  return users.map((item: any) => ({ id: item.id || item.uid, ...item }));
};
