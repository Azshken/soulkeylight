// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SoulKey} from "../contracts/SoulKey.sol";
import {MasterKeyVault} from "../contracts/MasterKeyVault.sol";

/**
 * @notice Deploys a new SoulKey game contract and registers it with the
 *         already-deployed MasterKeyVault. Run once per game.
 *
 * Usage:
 *   forge script script/DeployGameContract.s.sol \
 *     --rpc-url $RPC_URL \
 *     --broadcast \
 *     --verify
 *
 * Required env vars:
 *   VAULT_ADDRESS     — deployed MasterKeyVault address
 *   GAME_NAME         — ERC-721 name  (e.g. "Fallout")
 *   GAME_SYMBOL       — ERC-721 symbol (e.g. "FALL")
 *   GAME_SUPPLY       — max mintable supply (e.g. 500)
 *   BASE_TOKEN_URI    — metadata base URI (e.g. "https://api.example.com/metadata/")
 */
contract DeployGameContract is Script {
    function run() external {
        address vaultAddress = vm.envAddress("VAULT_ADDRESS");
        string memory name = vm.envString("GAME_NAME");
        string memory symbol = vm.envString("GAME_SYMBOL");
        uint64 supply = uint64(vm.envUint("GAME_SUPPLY"));
        string memory appUrl = vm.envString("NEXT_PUBLIC_APP_URL"); // https://yourapp.vercel.app

        // Sanity checks before broadcasting
        require(
            vaultAddress != address(0),
            "NEXT_PUBLIC_VAULT_ADDRESS not set"
        );
        require(supply > 0, "GAME_SUPPLY must be > 0");

        vm.startBroadcast();

        // Address isn't known until after deployment, so deploy first with a placeholder
        SoulKey soulKey = new SoulKey(
            vaultAddress,
            "", // placeholder - set immediately below
            name,
            symbol,
            supply
        );

        // Now address is known — build the full dynamic route URI and set it
        string memory baseURI = string.concat(
            appUrl,
            "/api/nft/",
            vm.toString(address(soulKey)),
            "/"
        );
        soulKey.setBaseURI(baseURI);

        // Incompatible with multisig vault ownership
        // Register immediately — msg.sender must be vault owner
        // MasterKeyVault(payable(vaultAddress)).registerGame(address(soulKey));

        vm.stopBroadcast();

        console.log("==============================================");
        console.log("SoulKey deployed:  ", address(soulKey));
        console.log("Base URI set to:   ", baseURI);
        console.log("Game name:         ", name);
        console.log("Symbol:            ", symbol);
        console.log("Max supply:        ", supply);
        console.log("Vault:             ", vaultAddress);
        console.log("==============================================");
        console.log(
            "Next step: go to /admin and Register Game with metadata CID"
        );
        console.log("to create the products DB entry for this contract.");
    }
}
