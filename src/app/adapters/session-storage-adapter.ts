import { Injectable } from '@angular/core';
@Injectable()
export class SessionStorageAdapter {
    get sessionStorage(): Storage {
        return sessionStorage;
    }
}
