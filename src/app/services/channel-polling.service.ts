import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest } from 'rxjs';
import { scan, switchMap, tap, map, shareReplay } from 'rxjs/operators';
import { Channel } from '../models/channel';
import { RaidenConfig } from './raiden.config';
import { RaidenService } from './raiden.service';
import { backoff } from '../shared/backoff.operator';
import { NotificationService } from './notification.service';
import { UiMessage } from '../models/notification';

@Injectable({
    providedIn: 'root'
})
export class ChannelPollingService {
    private channelsSubject: BehaviorSubject<void> = new BehaviorSubject(null);
    private refreshingSubject: BehaviorSubject<boolean> = new BehaviorSubject<
        boolean
    >(false);
    private readonly channels$: Observable<Channel[]>;
    private loaded = false;

    constructor(
        private raidenService: RaidenService,
        private notificationService: NotificationService,
        private raidenConfig: RaidenConfig
    ) {
        let timeout;
        this.channels$ = this.channelsSubject.pipe(
            tap(() => {
                clearTimeout(timeout);
                this.refreshingSubject.next(true);
            }),
            switchMap(() => this.raidenService.getChannels()),
            tap(() => {
                timeout = setTimeout(
                    () => this.refresh(),
                    this.raidenConfig.config.poll_interval
                );
                this.refreshingSubject.next(false);
            }),
            scan((oldChannels: Channel[], newChannels: Channel[]) => {
                this.checkForNewChannels(oldChannels, newChannels);
                return newChannels;
            }, []),
            backoff(
                this.raidenConfig.config.error_poll_interval,
                this.raidenService.globalRetry$
            ),
            shareReplay({ refCount: true, bufferSize: 1 })
        );
    }

    public refreshing(): Observable<boolean> {
        return this.refreshingSubject;
    }

    public channels(): Observable<Channel[]> {
        return combineLatest([
            this.channels$,
            this.raidenService.getPendingChannels()
        ]).pipe(
            map(([channels, pendingChannels]) => {
                const uniquePendingChannels = pendingChannels.filter(
                    pendingChannel =>
                        !channels.find(
                            channel =>
                                channel.partner_address ===
                                    pendingChannel.partner_address &&
                                channel.token_address ===
                                    pendingChannel.token_address
                        )
                );
                return channels.concat(uniquePendingChannels);
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        );
    }

    public refresh() {
        this.channelsSubject.next(null);
    }

    private checkForNewChannels(
        oldChannels: Channel[],
        newChannels: Channel[]
    ) {
        if (oldChannels.length > 0) {
            const channels = newChannels.filter(newChannel => {
                return !oldChannels.find(oldChannel =>
                    this.isTheSameChannel(oldChannel, newChannel)
                );
            });

            for (const channel of channels) {
                this.informAboutNewChannel(channel);
            }
        } else if (
            this.loaded &&
            oldChannels.length === 0 &&
            newChannels.length > 0
        ) {
            for (const channel of newChannels) {
                this.informAboutNewChannel(channel);
            }
        }
        this.loaded = true;
    }

    // noinspection JSMethodCanBeStatic
    private isTheSameChannel(channel1: Channel, channel2: Channel): boolean {
        return (
            channel1.channel_identifier.isEqualTo(
                channel2.channel_identifier
            ) && channel1.token_address === channel2.token_address
        );
    }

    private informAboutNewChannel(channel: Channel) {
        const channelId = channel.channel_identifier;
        const partnerAddress = channel.partner_address;
        const network = channel.userToken.name;
        const message: UiMessage = {
            title: 'New channel',
            description: `A new channel (${channelId}) was opened with ${partnerAddress} in ${network} network`
        };

        this.notificationService.addInfoNotification(message);
    }
}
