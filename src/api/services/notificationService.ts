import { supabaseAdmin } from '../../lib/supabase.js';

export interface CreateNotificationParams {
  userId?: string | null;
  userEmail: string;
  title: string;
  message: string;
  type?: string;
  orderId?: string | null;
  vpnName?: string | null;
  vpnUuid?: string | null;
}

export const createCustomerNotification = async (params: CreateNotificationParams): Promise<any> => {
  const { userId, userEmail, title, message, type = 'info', orderId, vpnName, vpnUuid } = params;

  let finalMessage = message;
  if (vpnName && !message.includes(vpnName)) {
    finalMessage = `${message} (VPN: ${vpnName})`;
  }

  const payload: any = {
    user_id: userId || null,
    user_email: userEmail,
    email: userEmail,
    title,
    message: finalMessage,
    type,
    read: false,
    is_read: false,
    order_id: orderId || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  try {
    let { data, error } = await supabaseAdmin.from('notifications').insert(payload).select().maybeSingle();

    if (error) {
      console.error(`[NotificationService] Database error inserting notification for ${userEmail}:`, error.message || error);
      
      if (error.code === 'PGRST204' || error.message?.includes('column')) {
        const fallbackPayload = {
          user_id: userId || null,
          user_email: userEmail,
          email: userEmail,
          title,
          message: finalMessage,
          created_at: new Date().toISOString()
        };
        const { data: retryData, error: retryErr } = await supabaseAdmin.from('notifications').insert(fallbackPayload).select().maybeSingle();
        if (retryErr) {
          console.error(`[NotificationService] Fallback notification insert failed for ${userEmail}:`, retryErr.message || retryErr);
          return null;
        }
        return retryData;
      }
      return null;
    }

    return data;
  } catch (err: any) {
    console.error(`[NotificationService] Exception during notification insert for ${userEmail}:`, err.message || err);
    return null;
  }
};

export const checkAndCreateExpiryNotifications = async (userId?: string, userEmail?: string): Promise<void> => {
  if (!userId && !userEmail) return;

  try {
    let query = supabaseAdmin.from('vpn_configs').select('*');
    if (userId && userEmail) {
      query = query.or(`customer_uid.eq.${userId},user_email.eq.${userEmail}`);
    } else if (userId) {
      query = query.eq('customer_uid', userId);
    } else if (userEmail) {
      query = query.eq('user_email', userEmail);
    }

    const { data: configs } = await query;
    if (!configs || configs.length === 0) return;

    const { data: existingNotifs } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .or(`user_id.eq.${userId || 'N/A'},user_email.eq.${userEmail || 'N/A'}`);

    const existingNotifList = existingNotifs || [];
    const now = Date.now();

    for (const cfg of configs) {
      const expVal = cfg.expiry_date || cfg.expiry_time || cfg.expiryDate || cfg.expiryTime;
      if (!expVal) continue;

      let expMs: number | null = null;
      if (typeof expVal === 'number') {
        expMs = expVal < 10000000000 ? expVal * 1000 : expVal;
      } else {
        expMs = new Date(expVal).getTime();
      }

      if (!expMs || isNaN(expMs)) continue;

      const diffMs = expMs - now;
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const vpnName = cfg.package_name || cfg.configName || cfg.remark || 'FIREVPN Package';
      const vpnUuid = cfg.uuid || cfg.id;

      let targetType = '';
      let targetTitle = '';
      let targetMessage = '';

      if (daysLeft === 3) {
        targetType = 'expiry_3d';
        targetTitle = 'VPN Expires in 3 Days';
        targetMessage = `Your VPN configuration "${vpnName}" expires in 3 days. Renew now to avoid service interruption.`;
      } else if (daysLeft === 2) {
        targetType = 'expiry_2d';
        targetTitle = 'VPN Expires in 2 Days';
        targetMessage = `Your VPN configuration "${vpnName}" expires in 2 days. Renew now to avoid service interruption.`;
      } else if (daysLeft === 1) {
        targetType = 'expiry_1d';
        targetTitle = 'VPN Expires Tomorrow';
        targetMessage = `Urgent: Your VPN configuration "${vpnName}" expires tomorrow! Renew now to keep your connection active.`;
      } else if (daysLeft <= 0) {
        targetType = 'expiry_expired';
        targetTitle = 'VPN Expired';
        targetMessage = `Your VPN configuration "${vpnName}" has expired. Renew now to restore high-speed access.`;
      }

      if (!targetType) continue;

      const alreadyExists = existingNotifList.some((n: any) => {
        const matchType = n.type === targetType;
        const matchName = (n.message && n.message.includes(vpnName)) || (n.title && n.title === targetTitle);
        return matchType && matchName;
      });

      if (!alreadyExists) {
        await createCustomerNotification({
          userId: userId || cfg.customer_uid || null,
          userEmail: userEmail || cfg.user_email,
          title: targetTitle,
          message: targetMessage,
          type: targetType,
          orderId: cfg.order_id || null,
          vpnName: vpnName,
          vpnUuid: vpnUuid
        });
      }
    }
  } catch (err) {
    console.warn('[NotificationService] Error syncing expiry notifications:', err);
  }
};

export const getUserNotifications = async (userId?: string, userEmail?: string): Promise<any[]> => {
  try {
    await checkAndCreateExpiryNotifications(userId, userEmail);

    const { data: allNotifs, error } = await supabaseAdmin.from('notifications').select('*').order('created_at', { ascending: false });
    if (error || !allNotifs) return [];

    const uId = userId ? String(userId).trim() : '';
    const uEmail = userEmail ? String(userEmail).toLowerCase().trim() : '';

    return allNotifs.filter((item: any) => {
      const itemUserId = String(item.user_id || '').trim();
      const itemEmail = String(item.user_email || item.email || '').toLowerCase().trim();
      return (uId && itemUserId === uId) || (uEmail && itemEmail === uEmail);
    });
  } catch (err) {
    console.warn('[NotificationService] Error fetching notifications:', err);
    return [];
  }
};

export const markNotificationAsRead = async (notificationId: string): Promise<boolean> => {
  try {
    const { error } = await supabaseAdmin.from('notifications').update({
      read: true,
      is_read: true,
      updated_at: new Date().toISOString()
    }).eq('id', notificationId);
    return !error;
  } catch (err) {
    console.warn('[NotificationService] Error marking notification as read:', err);
    return false;
  }
};
