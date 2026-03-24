import { Platform } from '../enums/platform.enum';

/**
 * User information
 */
export interface User {
  id?: number;
  phone: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  token?: string;
  zoneId?: number;
  isPhoneVerified?: boolean;
  isEmailVerified?: boolean;
  hasPersonalInfo?: boolean;
  image?: string | null;
}

/**
 * Address information
 */
export interface Address {
  id?: number;
  userId?: number;
  addressType?: 'home' | 'office' | 'other';
  contactPersonName?: string;
  contactPersonNumber?: string;
  address?: string;
  latitude?: string;
  longitude?: string;
  landmark?: string;
  road?: string;
  house?: string;
  floor?: string;
  zoneId?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Order information
 */
export interface Order {
  id?: number;
  userId: number;
  orderAmount: number;
  deliveryCharge: number;
  pickupAddress: Address;
  deliveryAddress: Address;
  distance?: number;
  paymentMethod: string;
  paymentStatus?: string;
  orderStatus?: string;
  orderNote?: string;
  receiverDetails?: {
    name?: string;
    phone?: string;
    landmark?: string;
    contact_person_name?: string;
    contact_person_number?: string;
    address?: string;
    latitude?: string;
    longitude?: string;
    floor?: string;
    road?: string;
    house?: string;
    zone_id?: number;
  };
  vehicleId?: number;
  moduleId?: number;
  createdAt?: Date;
}

/**
 * Message to be sent to user
 */
export interface Message {
  platform: Platform;
  recipientId: string;  // Phone number, chat ID, etc.
  text?: string;
  imageUrl?: string;
  buttons?: MessageButton[];
  listItems?: MessageListItem[];
}

/**
 * Message button
 */
export interface MessageButton {
  id: string;
  title: string;
}

/**
 * Message list item
 */
export interface MessageListItem {
  id: string;
  title: string;
  description?: string;
}
