package control

import "reasonix/internal/sessioninbox"

func (c *Controller) LookupInboxReceipt(key string) (sessioninbox.InboxReceipt, bool, error) {
	store, err := c.ensureInbox()
	if err != nil {
		return sessioninbox.InboxReceipt{}, false, err
	}
	receipt, found := store.LookupReceipt(key)
	return receipt, found, nil
}
