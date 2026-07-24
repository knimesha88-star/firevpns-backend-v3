import { supabase } from '../../lib/supabase.js';

export const getUserProfile = async (uid: string): Promise<any> => {
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (profile) return profile;
  const { data: user } = await supabase.from('users').select('*').or(`id.eq.${uid},uid.eq.${uid}`).maybeSingle();
  return user || null;
};

export const updateUserProfile = async (uid: string, data: any): Promise<void> => {
  const { error } = await supabase.from('profiles').update(data).eq('id', uid);
  if (error) {
    await supabase.from('profiles').upsert({ id: uid, ...data }, { onConflict: 'id' });
  }
};
