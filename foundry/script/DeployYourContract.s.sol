// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MasterKeyVault} from "../contracts/MasterKeyVault.sol";
import {SoulKey} from "../contracts/SoulKey.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Deployment script for MasterKeyVault + SoulKey
 * @dev Deploy order: MasterKeyVault → SoulKey → registerGame
 *
 * Local:
 *   yarn deploy --file DeployContracts.s.sol
 *
 * Sepolia:
 *   yarn deploy --file DeployContracts.s.sol --network sepolia
 */

/// @dev 6-decimal mock to match real USDT/USDC behaviour on localhost
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract DeployContracts is Script {
    // ── Sepolia token addresses ───────────────────────────────────────────────
    address constant SEPOLIA_USDT = 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0;
    address constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    // ── Game config — edit before deploying a new game ────────────────────────
    string constant BASE_URI = "https://api.example.com/metadata/";
    string constant GAME_NAME = "Fallout";
    string constant GAME_SYMBOL = "FALL";
    uint64 constant GAME_SUPPLY = 100;

    function run() public {
        address usdtAddress;
        address usdcAddress;

        if (block.chainid == 31337) {
            // ── Localhost / Anvil ─────────────────────────────────────────────
            uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
            vm.startBroadcast(deployerKey);

            MockERC20 mockUSDT = new MockERC20("Mock USDT", "USDT");
            MockERC20 mockUSDC = new MockERC20("Mock USDC", "USDC");
            usdtAddress = address(mockUSDT);
            usdcAddress = address(mockUSDC);

            console.log("Mock USDT:", usdtAddress);
            console.log("Mock USDC:", usdcAddress);
        } else if (block.chainid == 11155111) {
            // ── Sepolia ───────────────────────────────────────────────────────
            vm.startBroadcast(); // uses --keystores / --account flag

            usdtAddress = SEPOLIA_USDT;
            usdcAddress = SEPOLIA_USDC;

            console.log("Using Sepolia USDT:", usdtAddress);
            console.log("Using Sepolia USDC:", usdcAddress);
        } else {
            revert(
                "Unsupported network. Use localhost (31337) or Sepolia (11155111)"
            );
        }

        // ── 1. Deploy MasterKeyVault ──────────────────────────────────────────
        MasterKeyVault vault = new MasterKeyVault(usdtAddress, usdcAddress);
        console.log("MasterKeyVault deployed:", address(vault));

        /** Deploying and registering the SoulKey contract commented out.
         *  Only the MasterKeyVault is deployed alone.
         *  Registering the game in this format doesn't support the Multisig.
         *  The SoulKey contracts can be deployed separatelly by DeployGameContract.s.sol
         */

        // // ── 2. Deploy SoulKey (game contract) ────────────────────────────────
        // SoulKey soulKey = new SoulKey(
        //     address(vault),
        //     BASE_URI,
        //     GAME_NAME,
        //     GAME_SYMBOL,
        //     GAME_SUPPLY
        // );
        // console.log("SoulKey deployed:       ", address(soulKey));

        // // ── 3. Register the game with the vault ──────────────────────────────
        // vault.registerGame(address(soulKey));
        // console.log("SoulKey registered in vault.");

        vm.stopBroadcast();

        // ── Summary ───────────────────────────────────────────────────────────
        console.log("---");
        console.log("Deployment complete.");
        console.log("  MasterKeyVault :", address(vault));
        // console.log("  SoulKey        :", address(soulKey));
        // console.log("  Game           :", GAME_NAME, "/", GAME_SYMBOL);
        // console.log("  Supply         :", GAME_SUPPLY);
        console.log("  USDT           :", usdtAddress);
        console.log("  USDC           :", usdcAddress);
    }
}
