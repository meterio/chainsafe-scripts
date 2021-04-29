import { ethers, BigNumber } from "ethers";
import PromisePool from '@supercharge/promise-pool';
import { promises as fsPromises} from 'fs';
import { createObjectCsvWriter } from 'csv-writer';
import { ObjectMap } from "csv-writer/src/lib/lang/object";
import { config } from 'dotenv';
import bridgeABI from "./bridge-abi.json";

config();

const ETH_PROVIDER = process.env.ETH_PROVIDER;
const METER_PROVIDER = process.env.METER_PROVIDER;

const ethProvider = new ethers.providers.JsonRpcProvider(ETH_PROVIDER);
const meterProvider = new ethers.providers.JsonRpcProvider(METER_PROVIDER);

const ethChainId = 1;
const meterChainId = 2;

const ethBridgeAddress = "0xd7fb746e905f60e0f84F5eE545104A05066eCD86";
const meterBridgeAddress = "0xcC5A4195323CB835f22A9B7c6C5Cf6691D4419ec";

const ethHandler = "0x5eb75e79CDa25AB88e4779aA00F1D5a95AC1352B"
const meterHandler = "0xf8A06b9E8B24Ea21E88930F9878C410334EE076f"

const ethBridge = new ethers.Contract(ethBridgeAddress, bridgeABI, ethProvider);
const meterBridge = new ethers.Contract(meterBridgeAddress, bridgeABI, meterProvider);

async function findFailedProposals(originName: string, destinationName: string, 
                                   originBridge: ethers.Contract, destinationBridge: ethers.Contract, 
                                   originChainID: number, destinationChainID: number, 
                                   destinationHandler: string, startOriginBlock: number = 0) {
    const totalDeposits = Number((await originBridge._depositCounts(destinationChainID)).toString());
    console.log("Searching thru " + totalDeposits + " deposits for")
    let noinces = [...Array(totalDeposits).keys()];

    const { results, errors } = await PromisePool
        .withConcurrency(4)
        .for(noinces)
        .process(async noince => {
            const originBridgeAddress = await originBridge.resolvedAddress
            console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Grabbing deposit record for " + noince);
            const records = (await originBridge._depositRecords(noince, destinationChainID));
            const hash = ethers.utils.solidityKeccak256(["address", "bytes"], [destinationHandler, records]);
            console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Grabbing proposal with hash " + hash)
            const proposal = await destinationBridge.getProposal(originChainID, noince, hash);
            
            if (proposal._resourceID == "0x0000000000000000000000000000000000000000000000000000000000000000") {
                console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] No proposal found, skipping")
                return null;
            }

            if (proposal._status == 3) {
                console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Proposal status success, skipping");
                return null;
            }

            console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Grabbing Deposit event")
            const event = originBridge.filters.Deposit(null, null, noince);
            const originEvents = await originBridge.queryFilter(event, 0, 'latest')

            let originBlockNumber = "0"
            if (originEvents.length == 0) {
                originBlockNumber = "Deposit not found on Origin Chain";
                console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] No Deposit event found")
            } else if (originEvents.length > 1) {
                originBlockNumber = "Multiple Deposit events with the noince " + noince + " found on the Origin Chain"; 
                console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Multiple Deposit events found with same noince")
            } else {
                const originEvent = originEvents[0];
                if (originEvent.args != null) {
                    if (originEvent.args.resourceID != proposal._resourceID) {
                        originBlockNumber = "Resource ID of Deposit event doesn't match Proposal, expected " + proposal._resourceID + " but got " + originEvent.args.resourceID;
                        console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Deposit event found, but proposal resource ID mismatch")
                    } else if (originEvent.args.destinationChainID != destinationChainID) {
                        originBlockNumber = "destinationChainID in Deposit event doesn't match expected " + destinationChainID + " got " + originEvent.args.destinationChainID;
                        console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Deposit event found, but destinationChainID  mismtach")
                    } else {
                        originBlockNumber = originEvent.blockNumber.toString();
                        console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Despot event found and verified")
                    }
                } else {
                    originBlockNumber = originEvent.blockNumber.toString() + " (unverified)";
                    console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Despot event found, but unverified (no data in event)")
                }

                if (originEvent.blockNumber < startOriginBlock) {
                    console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Deposit event occured before " + startOriginBlock + ", skipping");
                    return null;
                }
            }
            
            if (proposal._status != 3) {
                console.log("[" + originName + " -> " + destinationName + " | Noince " + noince + "] Proposal status is not success, logging data found")
                const yes_votes_string = proposal._yesVotes.join()
                const no_votes_string = proposal._noVotes.join()

                return {
                    'origin': originName,
                    'destination': destinationName,
                    'proposal_resource_id': proposal._resourceID,
                    'proposal_dataHash': proposal._dataHash,
                    'proposal_yes_votes_count': proposal._yesVotes.length,
                    'proposal_no_votes_count': proposal._noVotes.length,
                    'proposal_yes_votes': yes_votes_string,
                    'proposal_no_votes': no_votes_string,
                    'proposal_status': proposal._status,
                    'proposal_proposed_block': proposal._proposedBlock.toString(),
                    'origin_block_number': originBlockNumber,
                }
            }

            return null;
        })
    
    return results.filter(p => p != null);
}

async function main() {
    try {
        const tempResults = await Promise.all([
            findFailedProposals('Ethereum', 'Meter', ethBridge, meterBridge, ethChainId, meterChainId, meterHandler),
            findFailedProposals('Meter', 'Ethereum', meterBridge, ethBridge, meterChainId, ethChainId, ethHandler)
        ]);
        console.log("Collecting all data");

        const results = tempResults[0].concat(tempResults[1]) as ObjectMap<any>[];

        console.log("Creating JSON data")
        const json = JSON.stringify(results);

        console.log("Creating CSV data");
        const csvWriter = createObjectCsvWriter({
            path: 'results.csv',
            header: [
                {id: 'origin', title: 'Origin'},
                {id: 'destination', title: 'Destination'},
                {id: 'proposal_resource_id', title: 'Resource ID'},
                {id: 'proposal_dataHash', title: 'Data Hash'},
                {id: 'proposal_yes_votes_count', title: 'Yes Vote Count'},
                {id: 'proposal_no_votes_count', title: 'No Vote Count'},
                {id: 'proposal_yes_votes', title: 'Yes Votes'},
                {id: 'proposal_no_votes', title: 'No Votes'},
                {id: 'proposal_status', title: 'Status'},
                {id: 'proposal_proposed_block', title: 'Proposed Block'},
                {id: 'origin_block_number', title: 'Deposit Block Number'}
            ]
        });

        console.log("Writing JSON file");
        await fsPromises.writeFile('results.json', json);

        console.log("Writing CSV file");
        await csvWriter.writeRecords(results);
    } catch (e) {
        console.log("Got unhandled error: " + e);
        console.log(e);
    }
}

main();
