import { Component, forwardRef, Input, OnDestroy, OnInit } from '@angular/core';
import {
    AbstractControl,
    ControlValueAccessor,
    FormControl,
    NG_VALIDATORS,
    NG_VALUE_ACCESSOR,
    ValidationErrors,
    Validator
} from '@angular/forms';
import { IdenticonCacheService } from '../../services/identicon-cache.service';
import { RaidenService } from '../../services/raiden.service';
import { AddressBookService } from '../../services/address-book.service';
import { Contact } from '../../models/contact';
import {
    debounceTime,
    flatMap,
    map,
    startWith,
    tap,
    switchMap
} from 'rxjs/operators';
import {
    merge,
    Observable,
    of,
    Subscription,
    partition,
    combineLatest
} from 'rxjs';
import AddressUtils from '../../utils/address-utils';
import { isAddressValid } from '../../shared/address.validator';
import { Network } from '../../utils/network-info';

@Component({
    selector: 'app-address-input',
    templateUrl: './address-input.component.html',
    styleUrls: ['./address-input.component.css'],
    providers: [
        {
            provide: NG_VALUE_ACCESSOR,
            useExisting: forwardRef(() => AddressInputComponent),
            multi: true
        },
        {
            provide: NG_VALIDATORS,
            useExisting: forwardRef(() => AddressInputComponent),
            multi: true
        }
    ]
})
export class AddressInputComponent
    implements ControlValueAccessor, Validator, OnInit, OnDestroy {
    @Input() placeholder: string;
    @Input() errorPlaceholder: string;
    @Input() displayIdenticon = false;
    @Input() userAccount = false;

    searching = false;

    private subscription: Subscription;
    private _value = '';
    private _errors: ValidationErrors | null = { emptyAddress: true };
    readonly inputFieldFc = new FormControl('');
    readonly network$: Observable<Network>;

    filteredOptions$: Observable<Contact[]>;
    // noinspection JSUnusedLocalSymbols
    private onChange = (address: string) => {};
    private onTouch: any = () => {};

    get address(): string {
        return this._value;
    }

    trackByFn(address: Contact) {
        return address.address;
    }

    constructor(
        private identiconCacheService: IdenticonCacheService,
        private raidenService: RaidenService,
        private addressBookService: AddressBookService
    ) {
        this.network$ = raidenService.network$;
    }

    ngOnInit(): void {
        this.setupValidation();

        if (this.userAccount) {
            this.setupFiltering();
        }
    }

    private setupFiltering() {
        this.filteredOptions$ = this.inputFieldFc.valueChanges.pipe(
            startWith(''),
            flatMap(value => this._filter(value))
        );
    }

    private setupValidation() {
        const [ens, address] = partition(
            this.inputFieldFc.valueChanges,
            (value: string | null | undefined) => AddressUtils.isDomain(value)
        );

        const resolveOnEns = () =>
            combineLatest([ens.pipe(debounceTime(800)), this.network$]).pipe(
                switchMap(([value, network]) =>
                    network.ensSupported
                        ? of(value).pipe(
                              tap(() => (this.searching = true)),
                              switchMap(name =>
                                  this.raidenService.resolveEnsName(name)
                              ),
                              tap(() => (this.searching = false)),
                              map(resolvedAddress => {
                                  if (resolvedAddress) {
                                      return { value: resolvedAddress };
                                  } else {
                                      return {
                                          value: '',
                                          errors: {
                                              unableToResolveEns: true
                                          }
                                      };
                                  }
                              })
                          )
                        : of({ value: '', errors: { ensUnsupported: true } })
                )
            );

        const handleAddress = () =>
            address.pipe(
                map((value: string) => {
                    const errors = isAddressValid(
                        value,
                        this.raidenService.raidenAddress
                    );
                    if (errors) {
                        value = '';
                    }
                    return {
                        value: value,
                        errors: errors
                    };
                })
            );

        this.subscription = merge(resolveOnEns(), handleAddress()).subscribe(
            (result: InputResult) => {
                this._value = result.value;
                this._errors = result.errors;

                this.onChange(result.value);

                if (result.errors) {
                    this.inputFieldFc.setErrors(result.errors);
                } else {
                    this.inputFieldFc.setErrors({
                        unableToResolveEns: null,
                        ensUnsupported: null,
                        ownAddress: null,
                        emptyAddress: null,
                        invalidFormat: null,
                        notChecksumAddress: null
                    });
                    this.inputFieldFc.updateValueAndValidity({
                        emitEvent: false
                    });
                }
            }
        );
    }

    ngOnDestroy(): void {
        const subscription = this.subscription;
        if (subscription) {
            subscription.unsubscribe();
        }
    }

    hint(): string | null {
        if (
            AddressUtils.isChecksum(this._value) &&
            AddressUtils.isDomain(this.inputFieldFc.value)
        ) {
            return this._value;
        } else {
            return null;
        }
    }

    // noinspection JSMethodCanBeStatic
    identicon(address: string): string {
        return this.identiconCacheService.getIdenticon(address);
    }

    registerOnChange(fn: any): void {
        this.onChange = fn;
    }

    registerOnTouched(fn: any): void {
        this.onTouch = fn;
    }

    setDisabledState(isDisabled: boolean): void {
        isDisabled ? this.inputFieldFc.disable() : this.inputFieldFc.enable();
    }

    writeValue(obj: any): void {
        if (!obj) {
            this.inputFieldFc.reset('', { emitEvent: true });
        } else {
            this._errors = null;
            this.inputFieldFc.setValue(obj, { emitEvent: true });
        }
        this.onChange(obj);
    }

    checksum(): string {
        return AddressUtils.toChecksumAddress(this.inputFieldFc.value);
    }

    registerOnValidatorChange(fn: () => void): void {}

    validate(c: AbstractControl): ValidationErrors | null {
        return this._errors;
    }

    private _filter(value: string | Contact): Observable<Contact[]> {
        const contacts$ = of(this.addressBookService.getArray());
        if (!value || typeof value !== 'string') {
            return contacts$;
        }

        const keyword = value.toLowerCase();

        function matches(contact: Contact) {
            const label = contact.label.toLocaleLowerCase();
            const address = contact.address.toLocaleLowerCase();
            return label.indexOf(keyword) >= 0 || address.indexOf(keyword) >= 0;
        }

        return contacts$.pipe(
            map((contacts: Contact[]) => contacts.filter(matches))
        );
    }
}

interface InputResult {
    value: string;
    errors: any;
}
