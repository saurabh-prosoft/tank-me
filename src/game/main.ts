import '@babylonjs/core/Debug/debugLayer';
import '@babylonjs/inspector';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import { GlowLayer } from '@babylonjs/core/Layers';
import { PhysicsViewer } from '@babylonjs/core/Debug';
import { Engine, Observer, Scene } from '@babylonjs/core';
import { SceneLoader } from '@babylonjs/core/Loading';
import { Axis, Space, Vector3 } from '@babylonjs/core/Maths';
import { AbstractMesh, MeshBuilder, TransformNode } from '@babylonjs/core/Meshes';
import { PBRMaterial, StandardMaterial, Texture } from '@babylonjs/core/Materials';
import { HavokPlugin, PhysicsAggregate, PhysicsShapeType } from '@babylonjs/core/Physics';
import { DirectionalLight, CascadedShadowGenerator } from '@babylonjs/core/Lights';
import { FollowCamera, FreeCamera, ArcRotateCamera } from '@babylonjs/core/Cameras';
import HavokPhysics from '@babylonjs/havok';
import { AdvancedDynamicTexture, Image, Control, Rectangle, Container } from '@babylonjs/gui';

import { GameClient } from '@/game/client';
import type { Player } from './state';
import { gravityVector, noop, throttle } from '@/utils/utils';
import { InputManager } from './input';
import { Tank } from './models/tank';
import { Ground } from './models/ground';
import { AssetLoader } from './loader';
import { Skybox } from './skybox';
import { GameInputType, MessageType } from '@/types/types';

export class World {
  private static instance: World;
  private static timeStep = 1 / 60;
  private static subTimeStep = 16;
  static physicsViewer: PhysicsViewer;

  private id: string;
  private state: Player;
  scene: Scene;
  private throttledResizeListener = noop;
  private stateUnsubFns: (() => boolean)[] = [];
  private glowLayer!: GlowLayer;
  private directionalLight!: DirectionalLight;
  private shadowGenerator!: CascadedShadowGenerator;
  private tppCamera!: FollowCamera;
  private fppCamera!: FreeCamera;
  private endCamera!: ArcRotateCamera;
  private playerMeshes: AbstractMesh[] = [];
  players: Record<string, Tank> = {};
  player!: Tank;
  private gui!: AdvancedDynamicTexture;
  private sights: (Control | Container)[] = [];
  private observers: Observer<Scene>[] = [];

  private constructor(
    public engine: Engine,
    public client: GameClient,
    public physicsPlugin: HavokPlugin
  ) {
    this.id = client.getSessionId()!;
    this.scene = new Scene(this.engine);
    this.scene.enablePhysics(gravityVector, physicsPlugin);
    World.physicsViewer = new PhysicsViewer(this.scene);
    // Not simulating anything until the scene is fully loaded
    physicsPlugin.setTimeStep(0);
    this.scene.getPhysicsEngine()?.setSubTimeStep(World.subTimeStep);
    this.state = client.state.get(this.id)!;
  }
  static async create(client: GameClient, canvas: HTMLCanvasElement): Promise<World> {
    if (!World.instance && client?.getSessionId()) {
      // Pre-fetch all assets
      await AssetLoader.load([
        { path: '/assets/game/models/Panzer I/Panzer_I.glb' },
        { path: '/assets/game/map/desert/height.png' },
        { path: '/assets/game/map/desert/diffuse.png' },
        { path: '/assets/game/textures/explosion.jpg' },
        { path: '/assets/game/textures/flare.png' },
        { path: '/assets/game/textures/fire.jpg' },
        { path: '/assets/game/textures/grass.png' },
        { path: '/assets/game/spritesheets/smoke_dust_cloud.png' },
        { path: '/assets/game/spritesheets/explosion.png' },
        { path: '/assets/game/spritesheets/fire.png' },
        { path: '/assets/game/audio/explosion.mp3', format: 'arraybuffer' },
        { path: '/assets/game/audio/cannon.mp3', format: 'arraybuffer' },
        { path: '/assets/game/audio/idle.mp3', format: 'arraybuffer' },
        { path: '/assets/game/audio/run.mp3', format: 'arraybuffer' },
        { path: '/assets/game/audio/load.mp3', format: 'arraybuffer' },
        { path: '/assets/game/audio/whizz1.mp3', format: 'arraybuffer' },
        { path: '/assets/game/audio/whizz2.mp3', format: 'arraybuffer' },
        { path: '/assets/game/gui/ads.png' },
        { path: '/assets/game/gui/overlay.png' }
      ]);

      // Init engine
      const engine = new Engine(canvas, true, { deterministicLockstep: true, lockstepMaxSteps: 4 });
      const physicsPlugin = new HavokPlugin(false, await HavokPhysics());
      const world = new World(engine, client, physicsPlugin);
      await world.importPlayerMesh(world);
      await world.initScene();
      world.initWindowListeners();
      world.start();

      World.instance = world;
      return world;
    }
    return World.instance;
  }
  private async importPlayerMesh(world: World) {
    const { meshes } = await SceneLoader.ImportMeshAsync(
      null,
      '/assets/game/models/Panzer I/',
      'Panzer_I.glb',
      world.scene
    );

    // Reset __root__ mesh's transform
    meshes[0].position = Vector3.Zero();
    meshes[0].rotation = Vector3.Zero();
    meshes[0].scaling = Vector3.One();
    const container = meshes.shift();
    setTimeout(() => container?.dispose());

    meshes.forEach((mesh) => {
      mesh.parent = mesh !== meshes[0] ? meshes[0] : null;

      // Disable shininess
      (mesh.material as PBRMaterial).metallicF0Factor = 0;
      mesh.isVisible = false;
    });
    meshes[0].name = 'Panzer_I:Ref';
    world.playerMeshes = meshes;
  }
  private async initScene() {
    // The classic :)
    this.setLights();
    this.setCameras();
    this.scene.actionManager = InputManager.create(this.scene);

    await Skybox.create(this.scene);
    await Ground.create(this.scene);
    this.shadowGenerator?.addShadowCaster(Ground.mesh);
    await this.createTanks();
    this.setBarriers();
    this.setGUI();

    this.observers.push(this.scene.onBeforeStepObservable.add(this.beforeStep.bind(this)));
    this.observers.push(this.scene.onAfterStepObservable.add(this.afterStep.bind(this)));
  }
  private initWindowListeners() {
    window.addEventListener('keydown', this.toggleInspect.bind(this));
    this.throttledResizeListener = throttle(this.resize.bind(this), 200);
    window.addEventListener('resize', this.throttledResizeListener.bind(this));
  }
  private start() {
    this.engine.runRenderLoop(this.render.bind(this));
    this.physicsPlugin.setTimeStep(World.timeStep);
  }
  private render() {
    this.scene.render();
    // fpsLabel.innerHTML = this.engine.getFps().toFixed() + ' FPS';
  }
  private setLights() {
    this.glowLayer = new GlowLayer('glow', this.scene);
    this.glowLayer.intensity = 1;
    this.glowLayer.blurKernelSize = 15;

    this.directionalLight = new DirectionalLight('DirectionalLight', new Vector3(0, 1, 0), this.scene);
    this.directionalLight.intensity = 1.3;
    this.directionalLight.position = new Vector3(0, 0, 0);
    this.directionalLight.direction = new Vector3(-1, -1.2, -1);
    this.shadowGenerator = new CascadedShadowGenerator(1024, this.directionalLight);
    this.shadowGenerator.useContactHardeningShadow = true;
    this.shadowGenerator.lambda = 1;
    this.shadowGenerator.cascadeBlendPercentage = 0;
    this.shadowGenerator.bias = 0.001;
    this.shadowGenerator.normalBias = 0.09;
    this.shadowGenerator.darkness = 0.34;
    this.shadowGenerator.autoCalcDepthBounds = true;
    this.shadowGenerator.autoCalcDepthBoundsRefreshRate = 2;
  }
  private setCameras() {
    // Set TPP Camera
    this.tppCamera = new FollowCamera('tpp-cam', new Vector3(0, 10, -10), this.scene);
    this.tppCamera.radius = 13;
    this.tppCamera.heightOffset = 4;
    this.tppCamera.rotationOffset = 180;
    this.tppCamera.cameraAcceleration = 0.05;
    this.tppCamera.maxCameraSpeed = 10;
    this.tppCamera.maxZ = 100000;
    this.scene.activeCamera = this.tppCamera;

    // Set FPP Camera
    this.fppCamera = new FreeCamera('fpp-cam', new Vector3(0.3, -0.309, 1), this.scene);
    this.fppCamera.minZ = 0.5;
    this.fppCamera.maxZ = 100000;

    // Set Kill Camera
    this.endCamera = new ArcRotateCamera('end-cam', 0, 0, 10, new Vector3(0, 0, 0), this.scene);

    this.shadowGenerator.autoCalcDepthBounds = true;
  }
  private setGUI() {
    this.gui = AdvancedDynamicTexture.CreateFullscreenUI('UI');
    const scope = new Image('ads', AssetLoader.assets['/assets/game/gui/ads.png'] as string);
    scope.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    scope.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    scope.autoScale = true;
    scope.width = '50%';
    scope.fixedRatio = 1;
    scope.stretch = Image.STRETCH_FILL;
    scope.shadowBlur = 3;
    scope.shadowColor = '#AFE1AF';
    scope.alpha = 0.8;
    scope.isVisible = false;
    scope.scaleX = 1.5;
    scope.scaleY = 1.5;
    this.gui.addControl(scope);

    const overlay = new Image('overlay', AssetLoader.assets['/assets/game/gui/overlay.png'] as string);
    overlay.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    overlay.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
    overlay.height = '100%';
    overlay.fixedRatio = 1;
    overlay.isVisible = false;
    this.gui.addControl(overlay);

    const padWidth = (this.engine.getRenderWidth(true) - this.engine.getRenderHeight(true)) / 2;
    const padLeft = new Rectangle('left-pad');
    padLeft.width = `${padWidth}px`;
    padLeft.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    padLeft.color = '#000';
    padLeft.background = '#000';
    padLeft.isVisible = false;
    this.gui.addControl(padLeft);

    const padRight = new Rectangle('right-pad');
    padRight.width = `${padWidth}px`;
    padRight.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
    padRight.color = '#000';
    padRight.background = '#000';
    padRight.isVisible = false;
    this.gui.addControl(padRight);

    this.sights.push(scope, overlay, padLeft, padRight);
  }
  private setBarriers() {
    const barrier = new TransformNode('barrier', this.scene);
    const barrierMaterial = new StandardMaterial('barrier', this.scene);
    barrierMaterial.diffuseTexture = new Texture('/assets/game/textures/metal.png', this.scene);
    barrierMaterial.diffuseTexture.level = 1.4;
    (barrierMaterial.diffuseTexture as Texture).uScale = 5;
    (barrierMaterial.diffuseTexture as Texture).vScale = 0.5;

    const barrier1 = MeshBuilder.CreateBox('barrier1', { width: 500, height: 20, depth: 1 }, this.scene);
    barrier1.position = new Vector3(0, 9, -249);
    barrier1.receiveShadows = true;
    barrier1.material = barrierMaterial;
    const barrier2 = MeshBuilder.CreateBox('barrier2', { width: 500, height: 20, depth: 1 }, this.scene);
    barrier2.position = new Vector3(0, 9, 249);
    barrier2.receiveShadows = true;
    barrier2.material = barrierMaterial;
    const barrier3 = MeshBuilder.CreateBox('barrier3', { width: 500, height: 20, depth: 1 }, this.scene);
    barrier3.rotate(Axis.Y, Math.PI / 2, Space.LOCAL);
    barrier3.position = new Vector3(-249, 9, 0);
    barrier3.receiveShadows = true;
    barrier3.material = barrierMaterial;
    const barrier4 = MeshBuilder.CreateBox('barrier4', { width: 500, height: 20, depth: 1 }, this.scene);
    barrier4.rotate(Axis.Y, Math.PI / 2, Space.LOCAL);
    barrier4.position = new Vector3(249, 9, 0);
    barrier4.receiveShadows = true;
    barrier4.material = barrierMaterial;

    barrier1.parent = barrier;
    barrier2.parent = barrier;
    barrier3.parent = barrier;
    barrier4.parent = barrier;

    // Not working
    /* const barrierShape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      new Vector3(250, 10, 1),
      this.scene
    );
    const barrierContainerShape = new PhysicsShapeContainer(this.scene);
    barrierShape.addChildFromParent(barrier, barrierShape, barrier1);
    barrierShape.addChildFromParent(barrier, barrierShape, barrier2);
    barrierShape.addChildFromParent(barrier, barrierShape, barrier3);
    barrierShape.addChildFromParent(barrier, barrierShape, barrier4);
    const barrierPB = new PhysicsBody(barrier, PhysicsMotionType.STATIC, false, this.scene);
    barrierPB.shape = barrierContainerShape;
    barrierPB.setMassProperties({ mass: 0, centerOfMass: Vector3.Zero() }); */

    new PhysicsAggregate(barrier1, PhysicsShapeType.BOX, { mass: 0 }, this.scene);
    new PhysicsAggregate(barrier2, PhysicsShapeType.BOX, { mass: 0 }, this.scene);
    new PhysicsAggregate(barrier3, PhysicsShapeType.BOX, { mass: 0 }, this.scene);
    new PhysicsAggregate(barrier4, PhysicsShapeType.BOX, { mass: 0 }, this.scene);
  }
  private beforeStep() {
    let isMoving = false;
    let isTurretMoving =
      InputManager.keys[GameInputType.TURRET_LEFT] || InputManager.keys[GameInputType.TURRET_RIGHT];
    const isBarrelMoving =
      InputManager.keys[GameInputType.BARREL_UP] || InputManager.keys[GameInputType.BARREL_DOWN];

    if (
      InputManager.keys[GameInputType.FORWARD] ||
      InputManager.keys[GameInputType.REVERSE] ||
      InputManager.keys[GameInputType.LEFT] ||
      InputManager.keys[GameInputType.RIGHT]
    ) {
      isMoving = true;
    }
    if (InputManager.keys[GameInputType.RESET] && !isTurretMoving && !isBarrelMoving) {
      isTurretMoving = true;
    }
    if (InputManager.keys[GameInputType.FIRE] && this.state.canFire) {
      this.player.fire();
    }
    if (InputManager.keys[GameInputType.CHANGE_PERSPECTIVE]) {
      this.player.toggleCamera();
      this.sights.forEach((ui) => (ui.isVisible = this.scene.activeCamera === this.fppCamera));
    }

    this.player.playSounds(isMoving, isBarrelMoving || isTurretMoving);
  }
  private afterStep() {
    if (this.client.isReady()) {
      this.client.sendEvent(MessageType.INPUT, InputManager.keys);
    }
  }
  private async createTanks() {
    const players: Player[] = [];
    this.client.getPlayers().forEach((player) => players.push(player));

    return await Promise.all(
      players.map(async (player) => {
        const isEnemy = this.id !== player.sid;
        this.players[player.sid] = await Tank.create(
          this,
          player,
          this.playerMeshes[0],
          new Vector3(player.position.x, player.position.y, player.position.z),
          !isEnemy ? { tpp: this.tppCamera, fpp: this.fppCamera } : null,
          isEnemy
        );
        this.shadowGenerator.addShadowCaster(this.players[player.sid].body as AbstractMesh);
        if (!isEnemy) this.player = this.players[player.sid];
      })
    );
  }
  private toggleInspect(ev: KeyboardEvent) {
    // Sfhit+Alt+I
    if (ev.shiftKey && ev.altKey && ev.code === 'KeyI') {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.scene.debugLayer.isVisible()) this.scene.debugLayer.hide();
      else this.scene.debugLayer.show();
    }
  }
  private resize() {
    this.engine.resize();
  }
  private stop() {
    this.physicsPlugin.setTimeStep(0);
    this.engine.stopRenderLoop();
  }

  public dispose() {
    this.stateUnsubFns.forEach((unsubFn) => unsubFn());
    window.removeEventListener('keydown', this.toggleInspect);
    window.removeEventListener('resize', this.throttledResizeListener);
    this.engine.dispose();
  }
  public updatePlayer(player: Player, id: string) {
    this.players[id].update(player);
  }
  public removePlayer(id: string) {
    this.players[id].dispose();
  }
}
