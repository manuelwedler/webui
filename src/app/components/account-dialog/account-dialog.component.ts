import { OnDestroy, ViewChild } from '@angular/core';
import { Component, OnInit } from '@angular/core';
import { FormGroup, FormBuilder, Validators } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { UserToken } from 'app/models/usertoken';
import { RaidenService } from 'app/services/raiden.service';
import { TokenPollingService } from 'app/services/token-polling.service';
import { Network } from 'app/utils/network-info';
import BigNumber from 'bignumber.js';
import { Observable, Subject, zip } from 'rxjs';
import { map, switchMap, takeUntil } from 'rxjs/operators';
import { TokenInputComponent } from '../token-input/token-input.component';

@Component({
    selector: 'app-account-dialog',
    templateUrl: './account-dialog.component.html',
    styleUrls: ['./account-dialog.component.css'],
})
export class AccountDialogComponent implements OnInit, OnDestroy {
    @ViewChild(TokenInputComponent, { static: true })
    private tokenInput: TokenInputComponent;

    form: FormGroup;

    token: UserToken;

    readonly balance$: Observable<BigNumber>;
    readonly network$: Observable<Network>;
    readonly faucetLink$: Observable<string>;
    readonly ethBalance$: Observable<string>;

    private ngUnsubscribe = new Subject();

    constructor(
        private dialogRef: MatDialogRef<AccountDialogComponent>,
        private raidenService: RaidenService,
        private fb: FormBuilder,
        private tokenPollingService: TokenPollingService
    ) {
        this.ethBalance$ = raidenService.balance$;
        this.network$ = raidenService.network$;
        this.faucetLink$ = zip(
            raidenService.network$,
            raidenService.raidenAddress$
        ).pipe(
            map(([network, raidenAddress]) =>
                network.faucet.replace('${ADDRESS}', raidenAddress)
            )
        );

        this.form = this.fb.group({
            token: [undefined, Validators.required], // TODO data.token
            amount: ['', Validators.required],
        });

        this.balance$ = this.form.controls.token.valueChanges.pipe(
            switchMap((token) =>
                this.tokenPollingService.getTokenUpdates(token?.address ?? '')
            ),
            map((token) => token.balance)
        );
    }

    ngOnInit(): void {
        this.form.controls.token.valueChanges
            .pipe(takeUntil(this.ngUnsubscribe))
            .subscribe((token) => {
                this.token = token;
                this.tokenInput.selectedToken = token;
            });
        this.form.controls.token.updateValueAndValidity();
    }

    ngOnDestroy() {
        this.ngUnsubscribe.next();
        this.ngUnsubscribe.complete();
    }

    close() {
        this.dialogRef.close();
    }
}
