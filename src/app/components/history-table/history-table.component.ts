import { Component, OnInit, OnDestroy } from '@angular/core';
import { PaymentHistoryPollingService } from '../../services/payment-history-polling.service';
import { Subject } from 'rxjs';
import { PaymentEvent } from '../../models/payment-event';
import { AddressBookService } from '../../services/address-book.service';
import { Animations } from '../../animations/animations';
import { SelectedTokenService } from '../../services/selected-token.service';
import { UserToken } from '../../models/usertoken';
import { SharedService } from '../../services/shared.service';
import { matchesToken, matchesContact } from '../../shared/keyword-matcher';
import { Contact } from '../../models/contact';
import { takeUntil } from 'rxjs/operators';

@Component({
    selector: 'app-history-table',
    templateUrl: './history-table.component.html',
    styleUrls: ['./history-table.component.css'],
    animations: Animations.flyInOut,
})
export class HistoryTableComponent implements OnInit, OnDestroy {
    visibleHistory: PaymentEvent[] = [];
    selectedToken: UserToken;

    private history: PaymentEvent[] = [];
    private searchFilter = '';
    private ngUnsubscribe = new Subject();

    constructor(
        private paymentHistoryPollingService: PaymentHistoryPollingService,
        private addressBookService: AddressBookService,
        private selectedTokenService: SelectedTokenService,
        private sharedService: SharedService
    ) {}

    ngOnInit() {
        this.paymentHistoryPollingService.paymentHistory$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((events) => {
                this.history = events;
                this.updateVisibleEvents();
            });

        this.selectedTokenService.selectedToken$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((token: UserToken) => {
                this.selectedToken = token;
                this.updateVisibleEvents();
            });

        this.sharedService.searchFilter$
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((value) => {
                this.searchFilter = value;
                this.updateVisibleEvents();
            });
    }

    ngOnDestroy() {
        this.ngUnsubscribe.next();
        this.ngUnsubscribe.complete();
    }

    trackByFn(index, item: PaymentEvent) {
        return item.log_time;
    }

    paymentPartner(event: PaymentEvent): string {
        const partnerAddress = this.partnerAddress(event);
        return this.addressLabel(partnerAddress) ?? partnerAddress;
    }

    partnerAddress(event: PaymentEvent): string {
        if (this.isReceivedEvent(event)) {
            return event.initiator;
        }
        return event.target;
    }

    getUTCTimeString(event: PaymentEvent): string {
        return event.log_time + 'Z';
    }

    isReceivedEvent(event: PaymentEvent): boolean {
        return event.event === 'EventPaymentReceivedSuccess';
    }

    private addressLabel(address: string): string | undefined {
        return this.addressBookService.get()[address];
    }

    private updateVisibleEvents() {
        const events = this.history;
        const visibleEvents: PaymentEvent[] = [];
        for (let i = events.length - 1; i >= 0; i--) {
            if (visibleEvents.length >= 4) {
                break;
            }

            const event = events[i];
            if (
                event.event === 'EventPaymentSentFailed' ||
                (this.selectedToken &&
                    event.token_address !== this.selectedToken.address) ||
                !this.matchesSearchFilter(event)
            ) {
                continue;
            }

            visibleEvents.push(event);
        }
        this.visibleHistory = visibleEvents;
    }

    private matchesSearchFilter(event: PaymentEvent): boolean {
        const keyword = this.searchFilter.toLocaleLowerCase();
        const paymentPartner = this.paymentPartner(event);

        let matchingToken = false;
        if (event.userToken) {
            matchingToken = matchesToken(keyword, event.userToken);
        }

        let matchingContact = false;
        const partnerLabel = this.addressLabel(paymentPartner);
        if (partnerLabel) {
            const contact: Contact = {
                address: paymentPartner,
                label: partnerLabel,
            };
            matchingContact = matchesContact(this.searchFilter, contact);
        }

        const partner = paymentPartner.toLocaleLowerCase();
        const tokenAddress = event.token_address.toLocaleLowerCase();

        return (
            partner.indexOf(keyword) >= 0 ||
            tokenAddress.indexOf(keyword) >= 0 ||
            matchingToken ||
            matchingContact
        );
    }
}
