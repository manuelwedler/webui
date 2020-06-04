import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { PaymentHistoryPollingService } from '../../services/payment-history-polling.service';
import { Subject, combineLatest, Subscription } from 'rxjs';
import { PaymentEvent } from '../../models/payment-event';
import { AddressBookService } from '../../services/address-book.service';
import { Animations } from '../../animations/animations';
import { SelectedTokenService } from '../../services/selected-token.service';
import { UserToken } from '../../models/usertoken';
import { SharedService } from '../../services/shared.service';
import { matchesToken, matchesContact } from '../../shared/keyword-matcher';
import { Contact } from '../../models/contact';
import { takeUntil, map, filter, tap } from 'rxjs/operators';
import { PendingTransferPollingService } from '../../services/pending-transfer-polling.service';
import { RaidenService } from '../../services/raiden.service';

export interface HistoryEvent extends PaymentEvent {
    pending?: boolean;
}

@Component({
    selector: 'app-history-table',
    templateUrl: './history-table.component.html',
    styleUrls: ['./history-table.component.css'],
    animations: Animations.flyInOut,
})
export class HistoryTableComponent implements OnInit, OnDestroy {
    private static ITEMS_PER_PAGE = 4;

    @Input() showAll = false;

    visibleHistory: HistoryEvent[] = [];//todo rename
    selectedToken: UserToken;
    currentPage = 1;

    // private history: HistoryEvent[] = [];
    private searchFilter = '';
    private readonly historySubject: Subject<HistoryEvent[]> = new Subject();
    private historyPollingSubscription: Subscription;
    private totalNumberOfEvents = 0;
    private numberOfPendingEvents = 0;
    private numberOfFilteredEvents = 0;
    private loaded = false;
    private ngUnsubscribe = new Subject();

    constructor(
        private paymentHistoryPollingService: PaymentHistoryPollingService,
        private addressBookService: AddressBookService,
        private selectedTokenService: SelectedTokenService,
        private sharedService: SharedService,
        private pendingTransferPollingService: PendingTransferPollingService,
        private raidenService: RaidenService
    ) {}

    get numberOfPages(): number {
        return Math.ceil(
            (this.totalNumberOfEvents + this.numberOfPendingEvents) /
                HistoryTableComponent.ITEMS_PER_PAGE
        );
    }

    ngOnInit() {
        this.paymentHistoryPollingService.newPaymentEvents$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((events) => {
                if (!this.loaded || events.length !== 0) {
                    this.totalNumberOfEvents = this.paymentHistoryPollingService.totalNumberOfEvents;
                    this.updateHistoryPolling();
                }
                this.loaded = true;
            });

        const pendingEvents$ = this.pendingTransferPollingService.pendingTransfers$.pipe(
            map((pendingTransfers) =>
                pendingTransfers
                    .map((pendingTransfer) => {
                        const initiator = pendingTransfer.role === 'initiator';
                        const event: HistoryEvent = {
                            target: pendingTransfer.target,
                            initiator: pendingTransfer.initiator,
                            event: initiator
                                ? 'EventPaymentSentSuccess'
                                : 'EventPaymentReceivedSuccess',
                            amount: pendingTransfer.locked_amount,
                            identifier: pendingTransfer.payment_identifier,
                            log_time: '',
                            token_address: pendingTransfer.token_address,
                            pending: true,
                        };
                        return event;
                    })
                    .reverse()
            ),
            tap((pendingEvents) => {
                if (this.numberOfPendingEvents !== pendingEvents.length) {
                    this.numberOfPendingEvents = pendingEvents.length;
                    this.updateHistoryPolling();
                }
            }),
            map((pendingEvents) => {
                const start =
                    HistoryTableComponent.ITEMS_PER_PAGE *
                    (this.currentPage - 1);
                const end = start + HistoryTableComponent.ITEMS_PER_PAGE;
                return pendingEvents.slice(start, end);
            })
        );

        const history$ = this.historySubject.pipe(
            map((events) => events.reverse())
        );

        combineLatest([history$, pendingEvents$])
            .pipe(
                map(
                    ([paymentEvents, pendingEvents]) =>
                        pendingEvents.concat(paymentEvents)
                ), 
                // filter((history) => {
                //     const filteredHistory = this.getFilteredEvents(history);
                //     const enoughEvents =
                //         filteredHistory.length <=
                //         HistoryTableComponent.ITEMS_PER_PAGE;
                //     if (
                //         filteredHistory.length <
                //         HistoryTableComponent.ITEMS_PER_PAGE
                //     ) {
                //         const missing =
                //             HistoryTableComponent.ITEMS_PER_PAGE -
                //             filteredHistory.length;
                //     }
                // }),
                filter((events) => events.length <= HistoryTableComponent.ITEMS_PER_PAGE),//maybe a problem with filter
                map((events) => {
                    const filteredEvents = this.getFilteredEvents(events);
                    console.log(events.length, filteredEvents.length)
                    if (filteredEvents.length < HistoryTableComponent.ITEMS_PER_PAGE) {//todo what if on last page
                        this.numberOfFilteredEvents += events.length - filteredEvents.length;
                        this.updateHistoryPolling();
                        return undefined;
                    }
                    return filteredEvents;
                }),
                filter((events) => events !== undefined),
                takeUntil(this.ngUnsubscribe)
            )
            .subscribe((events) => {
                this.visibleHistory = events;
            });

        this.selectedTokenService.selectedToken$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((token: UserToken) => {
                this.numberOfFilteredEvents = 0;
                this.selectedToken = token;
                this.currentPage = 1;
                this.updateHistoryPolling();
            });

        this.sharedService.searchFilter$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((value) => {
                this.numberOfFilteredEvents = 0;
                this.searchFilter = value;
                this.currentPage = 1;
                this.updateHistoryPolling();
            });
    }

    ngOnDestroy() {
        this.ngUnsubscribe.next();
        this.ngUnsubscribe.complete();
    }

    trackByFn(index, item: HistoryEvent) {
        return `${item.log_time}_${item.identifier}_${item.token_address}_${item.initiator}_${item.target}`;
    }

    nextPage() {
        if (this.currentPage >= this.numberOfPages) {
            return;
        }
        this.currentPage += 1;
        this.updateHistoryPolling();
    }

    previousPage() {
        if (this.currentPage <= 1) {
            return;
        }
        this.currentPage -= 1;
        this.updateHistoryPolling();
    }

    paymentPartner(event: HistoryEvent): string {
        const partnerAddress = this.partnerAddress(event);
        return this.addressLabel(partnerAddress) ?? partnerAddress;
    }

    partnerAddress(event: HistoryEvent): string {
        if (this.isReceivedEvent(event)) {
            return event.initiator;
        }
        return event.target;
    }

    getUTCTimeString(event: HistoryEvent): string {
        return event.log_time + 'Z';
    }

    isReceivedEvent(event: HistoryEvent): boolean {
        return event.event === 'EventPaymentReceivedSuccess';
    }

    getUserToken(event: HistoryEvent): UserToken {
        return this.raidenService.getUserToken(event.token_address);
    }

    private addressLabel(address: string): string | undefined {
        return this.addressBookService.get()[address];
    }

    // private updateVisibleEvents() {
    //     // how to get number of pages
    //     const filteredEvents = this.getFilteredEvents();
    //     this.numberOfPages = Math.ceil(
    //         filteredEvents.length / HistoryTableComponent.ITEMS_PER_PAGE
    //     );

    //     const visibleEvents: HistoryEvent[] = [];
    //     const start = this.currentPage * HistoryTableComponent.ITEMS_PER_PAGE;
    //     for (let i = filteredEvents.length - 1 - start; i >= 0; i--) {
    //         if (visibleEvents.length >= HistoryTableComponent.ITEMS_PER_PAGE) {
    //             break;
    //         }
    //         visibleEvents.push(filteredEvents[i]);
    //     }
    //     this.visibleHistory = visibleEvents;
    // } // mucho todo

    private getFilteredEvents(events: HistoryEvent[]) {
        return events.filter(
            (event) =>
                this.matchesSearchFilter(event) &&
                !(
                    this.selectedToken &&
                    event.token_address !== this.selectedToken.address
                )
        );
    }

    private matchesSearchFilter(event: HistoryEvent): boolean {
        const keyword = this.searchFilter.toLocaleLowerCase();
        const partnerAddress = this.partnerAddress(event);

        let matchingToken = false;
        const userToken = this.getUserToken(event);
        if (userToken) {
            matchingToken = matchesToken(keyword, userToken);
        }

        let matchingContact = false;
        const partnerLabel = this.addressLabel(partnerAddress);
        if (partnerLabel) {
            const contact: Contact = {
                address: partnerAddress,
                label: partnerLabel,
            };
            matchingContact = matchesContact(this.searchFilter, contact);
        }

        const partner = partnerAddress.toLocaleLowerCase();
        const tokenAddress = event.token_address.toLocaleLowerCase();

        return (
            partner.indexOf(keyword) >= 0 ||
            tokenAddress.indexOf(keyword) >= 0 ||
            matchingToken ||
            matchingContact
        );
    }

    private updateHistoryPolling() {
        const offset =
            this.totalNumberOfEvents +
            this.numberOfPendingEvents -
            this.currentPage * HistoryTableComponent.ITEMS_PER_PAGE;
        let limit = HistoryTableComponent.ITEMS_PER_PAGE + this.numberOfFilteredEvents;
        if (offset < 0) {
            limit += offset;
        }
        console.log('pollpage', limit, offset);

        if (this.historyPollingSubscription) {
            this.historyPollingSubscription.unsubscribe();
        }
        this.historyPollingSubscription = this.paymentHistoryPollingService
            .getHistory(undefined, undefined, Math.max(0, limit), Math.max(0, offset))
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe(this.historySubject);
    }
}
