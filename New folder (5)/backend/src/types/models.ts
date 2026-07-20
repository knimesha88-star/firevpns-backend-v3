export interface VPNClient {
  id: string;
  email: string;
  up: number;
  down: number;
  total: number;
  expiryTime: number;
  enable: boolean;
  subId: string;
}
