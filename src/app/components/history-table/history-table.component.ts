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
import { takeUntil, map, filter, tap, last } from 'rxjs/operators';
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
    private static EVENTS_PER_CALL = 25;

    @Input() showAll = false;

    visibleHistory: HistoryEvent[] = [];//todo rename
    selectedToken: UserToken;
    currentPage = 1;
    onLastPage = false;

    // private history: HistoryEvent[] = [];
    private searchFilter = '';
    private readonly historySubject: Subject<HistoryEvent[]> = new Subject();
    private historyPollingSubscription: Subscription;
    private totalNumberOfEvents = 0;
    private numberOfPendingEvents = 0;
    private offset = 0;
    private currentCallPage = 1;
    private onLastCallPage = false;
    private gettingPreviousPage = false;
    private firstVisibleElementIndex = -1;
    private lastVisibleElementIndex = -1;
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
                console.log('eventlength', events.length);
                if (!this.loaded || events.length !== 0) {
                    this.totalNumberOfEvents = this.paymentHistoryPollingService.totalNumberOfEvents;
                    this.resetHistoryPollingParameters(); //todo i want to keep the currentPage
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
            ) // todo maybe filter before tap
            // tap((pendingEvents) => {
            //     if (this.numberOfPendingEvents !== pendingEvents.length) {
            //         this.numberOfPendingEvents = pendingEvents.length;
            //         this.updateHistoryPolling();//todo
            //     }
            // }),
            // map((pendingEvents) => {
            //     // todo filter before slice
            //     const start =
            //         HistoryTableComponent.ITEMS_PER_PAGE *
            //         (this.currentPage - 1);
            //     const end = start + HistoryTableComponent.ITEMS_PER_PAGE;
            //     return pendingEvents.slice(start, end);
            // }) // todo buggy!!!!!
        );

        const history$ = this.historySubject.pipe(
            map((events) => {
                const displayableEvents: HistoryEvent[] = [];
                let firstElement = -1;
                let lastElement = -1;

                if (this.gettingPreviousPage) {
                    for (let i = 0; i < events.length; i++) {
                        if (this.matchesFilter(events[i])) {
                            displayableEvents.push(events[i]);
                            firstElement = i;
                            if (lastElement === -1) {
                                lastElement = i;
                            }
                        }
                        if (
                            displayableEvents.length ===
                            HistoryTableComponent.ITEMS_PER_PAGE
                        ) {
                            break;
                        }
                    }
                    displayableEvents.reverse();
                } else {
                    for (let i = events.length - 1; i >= 0; i--) {
                        if (this.matchesFilter(events[i])) {
                            displayableEvents.push(events[i]);
                            lastElement = i;
                            if (firstElement === -1) {
                                firstElement = i;
                            }
                        }
                        if (
                            displayableEvents.length ===
                            HistoryTableComponent.ITEMS_PER_PAGE
                        ) {
                            break;
                        }
                    }
                    this.onLastPage = this.onLastCallPage && this.getFilteredEvents(events).length <= HistoryTableComponent.ITEMS_PER_PAGE;//todo problem with ret only 4, we need to poll more to know if there is more
                }

                if (
                    displayableEvents.length ===
                        HistoryTableComponent.ITEMS_PER_PAGE ||
                    this.onLastPage
                ) {
                    this.currentCallPage = 1;
                    this.firstVisibleElementIndex = firstElement + this.offset;
                    this.lastVisibleElementIndex = lastElement + this.offset;
                    console.log('firstlast', this.firstVisibleElementIndex, this.lastVisibleElementIndex)
                    return displayableEvents;
                }

                //todo what if on last page: && currentCallPage !== totalNumberOfEvents / EVENTS_PER_CALL
                this.currentCallPage++;//todo when reset??
                this.updateHistoryPolling();
                return undefined;
            }),
            filter((events) => events !== undefined)
        );

        combineLatest([history$, pendingEvents$])
            .pipe(
                map(([paymentEvents, pendingEvents]) =>
                    pendingEvents.concat(paymentEvents)
                ), 
                takeUntil(this.ngUnsubscribe)
            )
            .subscribe((events) => {
                this.visibleHistory = events;
            });

        this.selectedTokenService.selectedToken$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((token: UserToken) => {
                this.selectedToken = token;
                this.resetHistoryPollingParameters();
                this.updateHistoryPolling();
            });

        this.sharedService.searchFilter$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((value) => {
                this.searchFilter = value;
                this.resetHistoryPollingParameters();
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
        if (this.onLastPage) {
            return;
        }
        this.currentPage += 1;// todo this can only get safely set when polling done
        this.gettingPreviousPage = false;
        this.currentCallPage = 1;
        this.updateHistoryPolling();
    }

    previousPage() {
        if (this.currentPage <= 1) {
            return;
        }
        this.currentPage -= 1;// todo this can only get safely set when polling done
        this.onLastPage = false;
        this.gettingPreviousPage = true;
        this.currentCallPage = 1;
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

    filterActive(): boolean {
        return !!this.selectedToken || !!this.searchFilter;
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

    private getFilteredEvents(events: HistoryEvent[]): HistoryEvent[] {
        return events.filter((event) => this.matchesFilter(event));
    }

    private matchesFilter(event: HistoryEvent): boolean {
        return (
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
        if (this.gettingPreviousPage) {
            this.offset = this.firstVisibleElementIndex + 1;
        } else {
            this.offset =
                this.lastVisibleElementIndex -
                this.currentCallPage * HistoryTableComponent.EVENTS_PER_CALL;
        }

        // todo this.offset filtered pending transfers
        let limit =
            this.currentCallPage * HistoryTableComponent.EVENTS_PER_CALL;
        if (this.offset <= 0) {
            limit += this.offset;
            this.offset = 0;
            this.onLastCallPage = true;// todo bug!
        }
        console.log('pollpage', limit, this.offset);

        if (this.historyPollingSubscription) {
            this.historyPollingSubscription.unsubscribe();
        }
        this.historyPollingSubscription = this.paymentHistoryPollingService
            .getHistory(
                undefined,
                undefined,
                Math.max(0, limit),
                this.offset
            )
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe(this.historySubject);
    }

    private resetHistoryPollingParameters() {
        this.currentPage = 1;
        this.lastVisibleElementIndex = this.totalNumberOfEvents;
        this.gettingPreviousPage = false;
        this.currentCallPage = 1;
        this.onLastCallPage = false;
    }
}
