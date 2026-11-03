-- The summary cards on รายการชำระเงิน (ชำระสำเร็จ · ค่าธรรมเนียม · ยอดสุทธิ · รอชำระ) become a role permission
-- (user, 2 Nov 2026: "user level should not see"). The roles that see them today keep them; User (viewer) does not.
-- Changeable per role on สิทธิ์การเข้าถึง. Super Admin ("*") always sees them.
UPDATE console_roles SET permissions = array_append(permissions, 'payment.totals')
 WHERE code IN ('admin', 'finance', 'support') AND NOT ('payment.totals' = ANY (permissions));
