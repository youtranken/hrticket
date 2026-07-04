import { TicketListView } from './TicketListView';

export function InboxPage() {
  return <TicketListView view="all" titleKey="menu.inbox" filterable />;
}

export function MyTicketsPage() {
  return <TicketListView view="mine" titleKey="menu.myTickets" filterable />;
}

export function PoolPage() {
  // The pool especially needs category/tag filters to pick the right work (#24);
  // the view stays pinned to 'pool' — only the extra filters ride the URL.
  return <TicketListView view="pool" titleKey="menu.pool" filterable />;
}
