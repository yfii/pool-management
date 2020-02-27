import fetch from 'isomorphic-fetch';
import { getAddress} from "ethers/utils";
import {Pool, PoolToken} from "../types";
import {bnum} from "../utils/helpers";

const SUBGRAPH_URL =
    process.env.REACT_APP_SUBGRAPH_URL ||
    'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-kovan';

export async function getPublicPools(): Promise<Pool[]> {
    const query = `
      query ($tokens: [Bytes!]) {
          pools (where: {publicSwap: true}) {
            id
            publicSwap
            finalized
            swapFee
            totalWeight
            totalShares
            tokensList
            tokens {
              id
              address
              balance
              decimals
              symbol
              denormWeight
            }
          }
        }
    `;

    const response = await fetch(SUBGRAPH_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query,
        }),
    });

    const { data } = await response.json();

    return data.pools.map(pool => {
        return {
            address: getAddress(pool.id),
            publicSwap: pool.publicSwap,
            finalized: pool.finalized,
            swapFee: bnum(pool.swapFee),
            totalWeight: bnum(pool.totalWeight),
            totalShares: bnum(pool.totalShares),
            tokensList: pool.tokensList.map(tokenAddress => {
                return getAddress(tokenAddress)
            }),
            tokens: pool.tokens.map(token => {
                return {
                    address: getAddress(token.address),
                    balance: bnum(token.balance),
                    decimals: token.decimals,
                    denormWeight: bnum(token.denormWeight),
                    symbol: token.symbol
                } as PoolToken
            })
        } as Pool;
    })
}