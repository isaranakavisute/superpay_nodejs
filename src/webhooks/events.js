/**
 * Webhook events a shop's endpoint can receive (ตั้งค่าการส่ง Webhook). Per endpoint and per event the admin
 * chooses: post it to the endpoint (webhook_endpoints.events) and/or alert Telegram (alert_events). Both off by default.
 */
export const WEBHOOK_EVENTS = [
  { code: 'payment.approved', group: 'เงินเข้า', label: 'ชำระเงินสำเร็จ', when: 'ออเดอร์ได้รับการอนุมัติ — ตรวจสลิปผ่านอัตโนมัติ ผู้ดูแลอนุมัติ หรือจับคู่จากกล่องรับ Event' },
  { code: 'payment.rejected', group: 'เงินเข้า', label: 'ชำระเงินไม่สำเร็จ / ยกเลิก', when: 'ผู้ดูแลปฏิเสธ ร้านยกเลิกผ่าน API หรือระบบยกเลิกอัตโนมัติ (ลูกค้าชำระผ่านออเดอร์ใหม่ / สลิปเดียวกันใช้กับออเดอร์อื่น)' },
  { code: 'payment.expired', group: 'เงินเข้า', label: 'ออเดอร์หมดอายุ', when: 'ออเดอร์ที่ยังไม่ได้ชำระเลยเวลาหมดอายุ (ตรวจพบเมื่อมีการเรียก API ครั้งถัดไป)' },
  { code: 'payment.refunded', group: 'เงินเข้า', label: 'คืนเงินแล้ว', when: 'ผู้ดูแลคืนเงินออเดอร์ที่อนุมัติแล้ว' },
  { code: 'payout.completed', group: 'โอนออก (payout API)', label: 'โอนออกสำเร็จ (ถอนสำเร็จ)', when: 'ผู้ดูแลตั้ง admin ดำเนินการ = yes (โอนเงินให้ผู้รับแล้ว) — ส่งครั้งเดียวต่อรายการ' },
  { code: 'payout.failed', group: 'โอนออก (payout API)', label: 'โอนออกไม่สำเร็จ', when: 'ผู้ดูแลปฏิเสธ payout (คืนยอดให้ร้าน)' },
  { code: 'withdrawal.approved', group: 'คำขอถอน', label: 'อนุมัติคำขอถอน', when: 'ผู้ดูแลอนุมัติคำขอถอน (สร้างรายการเงินออก รอโอน)' },
  { code: 'withdrawal.completed', group: 'คำขอถอน', label: 'ถอนเงินสำเร็จ', when: 'ผู้ดูแลอนุมัติรายการเงินออกของคำขอถอน (โอนเงินแล้ว)' },
  { code: 'withdrawal.rejected', group: 'คำขอถอน', label: 'ปฏิเสธคำขอถอน', when: 'ผู้ดูแลปฏิเสธคำขอถอน' },
];

export const EVENT_CODES = WEBHOOK_EVENTS.map((e) => e.code);
