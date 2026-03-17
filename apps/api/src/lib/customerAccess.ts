type CustomerAccessLike = {
  customerAccessStatus?: string | null;
  isAlphaTester?: boolean | null;
};

export function resolveCustomerAccessStatus(user: CustomerAccessLike | null | undefined): string {
  const status = user?.customerAccessStatus ?? null;

  if (status === 'REJECTED' || status === 'SUSPENDED' || status === 'APPROVED') {
    return status;
  }

  // Backward compatibility for legacy approvals that only flipped
  // the alpha flag before customerAccessStatus existed.
  if (user?.isAlphaTester) {
    return 'APPROVED';
  }

  return 'PENDING_REVIEW';
}
