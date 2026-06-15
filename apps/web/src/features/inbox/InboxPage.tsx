import { TicketListView } from './TicketListView';

export function InboxPage() {
  return <TicketListView view="all" titleKey="menu.inbox" filterable />;
}

export function MyTicketsPage() {
  return <TicketListView view="mine" titleKey="menu.myTickets" />;
}

export function PoolPage() {
  return <TicketListView view="pool" titleKey="menu.pool" />;
}
