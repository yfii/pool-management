import { action, observable, ObservableMap } from 'mobx';
import RootStore from 'stores/Root';
import { ethers } from 'ethers';
import UncheckedJsonRpcSigner from 'provider/UncheckedJsonRpcSigner';
import { ActionResponse, sendAction } from './actions/actions';
import { web3Window as window } from 'provider/Web3Window';
import { backupUrls, supportedChainId, web3Modal } from 'provider/connectors';

export enum ContractTypes {
    BPool = 'BPool',
    BFactory = 'BFactory',
    TestToken = 'TestToken',
    ExchangeProxy = 'ExchangeProxy',
    ExchangeProxyCallable = 'ExchangeProxyCallable',
    Weth = 'Weth'
}

export const schema = {
    BPool: require('../abi/BPool').abi,
    BFactory: require('../abi/BFactory').abi,
    TestToken: require('../abi/TestToken').abi,
    ExchangeProxy: require('../abi/ExchangeProxy').abi,
    ExchangeProxyCallable: require('../abi/ExchangeProxyCallable').abi,
    Weth: require('../abi/Weth').abi
};

export interface ChainData {
    currentBlockNumber: number;
}

enum ERRORS {
    UntrackedChainId = 'Attempting to access data for untracked chainId',
    ContextNotFound = 'Specified context name note stored',
    BlockchainActionNoAccount = 'Attempting to do blockchain transaction with no account',
    BlockchainActionNoChainId = 'Attempting to do blockchain transaction with no chainId',
    BlockchainActionNoResponse = 'No error or response received from blockchain action',
    NoWeb3 = 'Error Loading Web3'
}

type ChainDataMap = ObservableMap<number, ChainData>;

export interface ProviderStatus {
    activeChainId: number;
    account: string;
    library: any;
    active: boolean;
    injectedLoaded: boolean;
    injectedActive: boolean;
    injectedChainId: number;
    injectedWeb3: any;
    backUpLoaded: boolean;
    backUpWeb3: any;
    error: Error;
}

export default class ProviderStore {

    @observable chainData: ChainData;
    @observable providerStatus: ProviderStatus;
    web3Modal: any;
    rootStore: RootStore;

    constructor(rootStore) {
        this.rootStore = rootStore;
        this.chainData = { currentBlockNumber: -1 } as ChainData;
        this.web3Modal = web3Modal;
        this.providerStatus = {} as ProviderStatus;
        this.providerStatus.active = false;
        this.providerStatus.injectedLoaded = false;
        this.providerStatus.injectedActive = false;
        this.providerStatus.backUpLoaded = false;

        this.handleNetworkChanged = this.handleNetworkChanged.bind(this);
        this.handleClose = this.handleClose.bind(this);
        this.handleAccountsChanged = this.handleAccountsChanged.bind(this);
    }

    getCurrentBlockNumber(): number {
        return this.chainData.currentBlockNumber;
    }

    async loadWeb3Modal(): Promise<void> {
        await this.web3Modal.connect();
    }

    @action setCurrentBlockNumber(blockNumber): void {
        this.chainData.currentBlockNumber = blockNumber;
    }

    @action fetchUserBlockchainData = async (
        account: string
    ) => {
        const {
            transactionStore,
            tokenStore,
            contractMetadataStore,
        } = this.rootStore;

        console.debug('[Provider] fetchUserBlockchainData', {
            account,
        });

        transactionStore.checkPendingTransactions(account);
        tokenStore
            .fetchTokenBalances(
                account,
                contractMetadataStore.getTrackedTokenAddresses()
            )
            .then(result => {
                console.debug('[Fetch End - User Blockchain Data]', {
                    account,
                });
            });
    };

    // account is optional
    getProviderOrSigner(library, account) {
        console.debug('[getProviderOrSigner', {
            library,
            account,
            signer: library.getSigner(account),
        });

        return account
            ? new UncheckedJsonRpcSigner(library.getSigner(account))
            : library;
    }

    getContract(
        type: ContractTypes,
        address: string,
        signerAccount?: string
    ): ethers.Contract {
        const library = this.providerStatus.library;

        if (signerAccount) {
            return new ethers.Contract(
                address,
                schema[type],
                this.getProviderOrSigner(this.providerStatus.library, signerAccount)
            );
        }

        return new ethers.Contract(address, schema[type], library);
    }

    @action sendTransaction = async (
        contractType: ContractTypes,
        contractAddress: string,
        action: string,
        params: any[],
        overrides?: any
    ): Promise<ActionResponse> => {
        const { transactionStore } = this.rootStore;
        const chainId = this.providerStatus.activeChainId;
        const account = this.providerStatus.account;

        overrides = overrides ? overrides : {};

        if (!account) {
            throw new Error(ERRORS.BlockchainActionNoAccount);
        }

        if (!chainId) {
            throw new Error(ERRORS.BlockchainActionNoChainId);
        }

        const contract = this.getContract(
            contractType,
            contractAddress,
            account
        );

        const response = await sendAction({
            contract,
            action,
            sender: account,
            data: params,
            overrides,
        });

        const { error, txResponse } = response;

        if (error) {
            console.warn('[Send Transaction Error', error);
        } else if (txResponse) {
            transactionStore.addTransactionRecord(account, txResponse);
        } else {
            throw new Error(ERRORS.BlockchainActionNoResponse);
        }

        return response;
    };

    @action async handleNetworkChanged(networkId: string | number): Promise<void> {
      console.log(`[Provider] Network change: ${networkId} ${this.providerStatus.active}`);
      // network change could mean switching from injected to backup or vice-versa
      if(this.providerStatus.active){
        await this.loadWeb3();
        const { blockchainFetchStore } = this.rootStore;
        blockchainFetchStore.setFetchLoop(true);
      }
    }

    @action async handleClose(): Promise<void> {
      console.log(`[Provider] HandleClose() ${this.providerStatus.active}`)
      if(this.providerStatus.active)
        await this.loadWeb3();
    }

    @action handleAccountsChanged(accounts: string[]): void {
      console.log(`[Provider] Accounts changed`)
      if (accounts.length === 0) {
        this.handleClose();
      } else {
        const { blockchainFetchStore } = this.rootStore;
        this.providerStatus.account = accounts[0];
        // Loads pool & balance data for account
        blockchainFetchStore.setFetchLoop(true);
      }
    }

    @action async loadWeb3() {
        /*
        Handles loading web3 provider.
        Injected web3 loaded and active if chain Id matches.
        Backup web3 loaded and active if no injected or injected chain Id not correct.
        */
        console.log(`[Provider] loadWeb3()`)
        let web3;

        if(window.ethereum){
          try{
            // remove any old listeners
            if (window.ethereum.removeListener) {
              window.ethereum.removeListener('chainChanged', this.handleNetworkChanged)
              window.ethereum.removeListener('accountsChanged', this.handleAccountsChanged)
              window.ethereum.removeListener('close', this.handleClose)
              window.ethereum.removeListener('networkChanged', this.handleNetworkChanged)
            }

            web3 = new ethers.providers.Web3Provider(window.ethereum);

            if ((window.ethereum as any).isMetaMask) {
              ;(window.ethereum as any).autoRefreshOnNetworkChange = false
            }

            if (window.ethereum.on) {
              window.ethereum.on('chainChanged', this.handleNetworkChanged)           // For now assume network/chain ids are same thing as only rare case when they don't match
              window.ethereum.on('accountsChanged', this.handleAccountsChanged)
              window.ethereum.on('close', this.handleClose)
              window.ethereum.on('networkChanged', this.handleNetworkChanged)
            }

            let network = await web3.getNetwork();

            const accounts = await web3.listAccounts();
            let account = null;
            if(accounts.length > 0)
              account = accounts[0];

            this.providerStatus.injectedLoaded = true;
            this.providerStatus.injectedChainId = network.chainId;
            this.providerStatus.account = account;
            this.providerStatus.injectedWeb3 = web3;
            //this.providerStatus.library = web3;
            //this.providerStatus.injectedActive = true;
            //this.providerStatus.activeChainId = network.chainId;
            console.log(`[Provider] Injected provider loaded.`)
          }catch(err){
            console.error(`[Provider] Injected Error`, err);
            this.providerStatus.injectedLoaded = false;
            this.providerStatus.injectedChainId = null;
            this.providerStatus.account = null;
            this.providerStatus.library = web3;
            this.providerStatus.active = false;
          }
        }

        // If no injected provider or inject provider is wrong chain fall back to Infura
        if (!this.providerStatus.injectedLoaded ||
            (this.providerStatus.injectedChainId !== supportedChainId)) {
          console.log(`[Provider] Reverting To Backup Provider.`, this.providerStatus);
          try{
            web3 = new ethers.providers.JsonRpcProvider(backupUrls[supportedChainId]);
            let network = await web3.getNetwork();
            this.providerStatus.injectedActive = false;
            this.providerStatus.backUpLoaded = true;
            this.providerStatus.account = null;
            this.providerStatus.activeChainId = network.chainId;
            this.providerStatus.backUpWeb3 = web3;
            this.providerStatus.library = web3;
            console.log(`[Provider] BackUp Provider Loaded & Active`);
          }catch(err){
            console.error(`[Provider] loadWeb3 BackUp Error`, err);
            this.providerStatus.injectedActive = false;
            this.providerStatus.backUpLoaded = false;
            this.providerStatus.account = null;
            this.providerStatus.activeChainId = null;
            this.providerStatus.backUpWeb3 = null;
            this.providerStatus.library = null;
            this.providerStatus.active = false;
            this.providerStatus.error = new Error(ERRORS.NoWeb3);
            return;
          }
        }else{
          console.log(`[Provider] Injected provider active.`);
          this.providerStatus.library = this.providerStatus.injectedWeb3;
          this.providerStatus.activeChainId = this.providerStatus.injectedChainId;
          this.providerStatus.injectedActive = true;
        }

        this.providerStatus.active = true;
        console.log(`[Provider] Successfully loaded provider.`, this.providerStatus)
    }
}
