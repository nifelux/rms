/**
 * Zod Schemas for Input Validation
 */
import { z } from 'zod';

export const depositSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  payment_method: z.string().optional(),
  proof: z.string().url().optional() // image URL from storage
});

export const withdrawSchema = z.object({
  amount: z.number().positive().max(500000, 'Exceeds maximum withdrawal'),
  bank_name: z.string().min(2),
  account_number: z.string().min(10).max(10),
  account_name: z.string().min(2)
});

export const investmentSchema = z.object({
  product_id: z.string().uuid(),
  amount: z.number().positive()
});

export const supportTicketSchema = z.object({
  subject: z.string().min(3),
  message: z.string().min(10)
});

export const kycUploadSchema = z.object({
  doc_type: z.enum(['id_front','id_back','selfie','address_proof']),
  image_url: z.string().url()
});

export const giftCodeCreateSchema = z.object({
  code: z.string().min(4),
  amount: z.number().positive(),
  max_uses: z.number().int().positive().default(1),
  expires_in_days: z.number().int().optional()
});
