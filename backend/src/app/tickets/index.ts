export { TicketsModule } from './ticket.module';
export {
  TicketService,
  type CreateTicketInput,
  type UpdateTicketPatch,
  type TicketDetail,
  type PromoteResult,
} from './ticket.service';
export { TicketEventBus, type TicketEvent } from './ticket-event-bus';
